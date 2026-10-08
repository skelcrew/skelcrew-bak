import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { SessionId, TaskId } from "../core/ids";
import type { Call } from "../protocol/protocol";
import { send } from "./client";
import { type Daemon, serve } from "./daemon";
import { ALREADY_RUNNING } from "./lock";
import { cleanUp, folder } from "./testing";

const running: Daemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  cleanUp();
});

async function started(repo: string): Promise<Daemon> {
  const served = await serve(repo, { socketFolder: join(folder(), "sockets") });
  if (!served.ok) throw new Error(served.message);
  running.push(served.daemon);
  return served.daemon;
}

const add = (title: string): Call => ({
  type: "send",
  task: null,
  input: { type: "add", title, description: null, plan: null },
});

describe("the daemon", () => {
  test("adds a task, and lists it", async () => {
    const daemon = await started(folder());

    expect(await send(daemon.socket, add("Fix the export"))).toEqual({
      ok: true,
      result: { kind: "sent", task: TaskId.parse(1) },
    });
    const listed = await send(daemon.socket, { type: "ls" });
    expect(listed.ok && listed.result).toEqual({
      kind: "tasks",
      tasks: [
        {
          task: TaskId.parse(1),
          title: "Fix the export",
          phase: "triage",
          intent: null,
          rigor: null,
          state: "queued",
        },
      ],
    });
  });

  test("lists a held task with why it is held", async () => {
    const daemon = await started(folder());
    await send(daemon.socket, add("Fix the export"));
    await send(daemon.socket, { type: "send", task: TaskId.parse(1), input: { type: "pause" } });

    const listed = await send(daemon.socket, { type: "ls" });
    expect(listed.ok && listed.result.kind === "tasks" && listed.result.tasks[0]?.state).toBe(
      "paused",
    );
  });

  test("gives each new task the next number", async () => {
    const daemon = await started(folder());
    await send(daemon.socket, add("One"));

    expect(await send(daemon.socket, add("Two"))).toEqual({
      ok: true,
      result: { kind: "sent", task: TaskId.parse(2) },
    });
  });

  test("answers a refusal from the core with its reason", async () => {
    const daemon = await started(folder());

    const answer = await send(daemon.socket, {
      type: "send",
      task: TaskId.parse(7),
      input: { type: "pause" },
    });
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.message).toContain("#7");
  });

  test("keeps its tasks across a restart", async () => {
    const repo = folder();
    const first = await started(repo);
    await send(first.socket, add("Fix the export"));
    await first.stop();

    const second = await started(repo);
    const listed = await send(second.socket, { type: "ls" });
    expect(listed.ok && listed.result.kind === "tasks" && listed.result.tasks.length).toBe(1);
  });

  test("refuses to start while another daemon runs the same repository", async () => {
    const repo = folder();
    await started(repo);

    const second = await serve(repo, { socketFolder: join(folder(), "sockets") });
    expect(!second.ok && second.message).toStartWith(ALREADY_RUNNING);
  });

  test("refuses to start with a bad skelcrew.yaml, saying what is wrong", async () => {
    const repo = folder();
    writeFileSync(join(repo, "skelcrew.yaml"), "limits:\n  max_running: lots\n");

    expect(await serve(repo)).toEqual({
      ok: false,
      message: "skelcrew.yaml: limits.max_running: expected a number, got string",
    });
  });

  test("answers a line it can't read with a refusal, and stays up", async () => {
    const daemon = await started(folder());

    const answer = await rawLine(daemon.socket, "{not json\n");
    expect(JSON.parse(answer)).toEqual({
      v: 1,
      id: "unknown",
      ok: false,
      message: "The request isn't valid JSON.",
    });
    expect((await send(daemon.socket, { type: "ls" })).ok).toBe(true);
  });
});

describe("the daemon's tick", () => {
  test("starts what waits, without a request to prompt it", async () => {
    const handed: string[] = [];
    const served = await serve(folder(), {
      socketFolder: join(folder(), "sockets"),
      tools: { carryOut: (command) => handed.push(command.type) },
      tickMs: 10,
    });
    if (!served.ok) throw new Error(served.message);
    running.push(served.daemon);

    await send(served.daemon.socket, add("Fix the export"));
    await until(() => handed.length > 0);

    expect(handed).toEqual(["create_workspace"]);
  });
});

describe("the daemon's fake tools", () => {
  test("make a workspace and start the planner, replying as the real tools would", async () => {
    const served = await serve(folder(), { socketFolder: join(folder(), "sockets"), tickMs: 10 });
    if (!served.ok) throw new Error(served.message);
    running.push(served.daemon);

    await send(served.daemon.socket, add("Fix the export"));
    let state = "";
    await untilAsync(async () => {
      const listed = await send(served.daemon.socket, { type: "ls" });
      state =
        listed.ok && listed.result.kind === "tasks" ? (listed.result.tasks[0]?.state ?? "") : "";
      return state === "running";
    });

    expect(state).toBe("running");
  });
});

describe("who is calling", () => {
  // A daemon whose planner for task 1 is running, and that planner's token.
  async function withPlanner() {
    const served = await serve(folder(), { socketFolder: join(folder(), "sockets"), tickMs: 10 });
    if (!served.ok) throw new Error(served.message);
    running.push(served.daemon);
    const daemon = served.daemon;
    await send(daemon.socket, add("Fix the export"));
    await untilAsync(async () => {
      const listed = await send(daemon.socket, { type: "ls" });
      return (
        listed.ok && listed.result.kind === "tasks" && listed.result.tasks[0]?.state === "running"
      );
    });
    // The fake tools name a session after its task and request.
    return { daemon, token: daemon.tokenFor(SessionId.parse("s-1-2")) };
  }

  const progress: Call = {
    type: "send",
    task: null,
    input: { type: "progress", text: "Reading the export code." },
  };

  test("hears an agent by its token, on its own task", async () => {
    const { daemon, token } = await withPlanner();

    expect(await send(daemon.socket, progress, token)).toEqual({
      ok: true,
      result: { kind: "sent", task: TaskId.parse(1) },
    });
  });

  test("refuses a token it didn't give", async () => {
    const { daemon } = await withPlanner();

    expect(await send(daemon.socket, progress, "s-1-2.0123")).toEqual({
      ok: false,
      message: "That session token isn't one this daemon gave.",
    });
  });

  test("refuses your commands from an agent", async () => {
    const { daemon, token } = await withPlanner();
    const approve: Call = { type: "send", task: TaskId.parse(1), input: { type: "approve" } };

    expect(await send(daemon.socket, approve, token)).toEqual({
      ok: false,
      message: "Only you can send `approve`, and this call comes from an agent's session.",
    });
  });

  test("refuses an agent's command without a token", async () => {
    const { daemon } = await withPlanner();

    expect(await send(daemon.socket, { ...progress, task: TaskId.parse(1) })).toEqual({
      ok: false,
      message:
        "`progress` is an agent's command. It needs the session's token in SKELCREW_SESSION.",
    });
  });

  test("refuses a session that no longer works on a task", async () => {
    const { daemon, token } = await withPlanner();
    await send(daemon.socket, { type: "send", task: TaskId.parse(1), input: { type: "kill" } });

    expect(await send(daemon.socket, progress, token)).toEqual({
      ok: false,
      message: "Session s-1-2 no longer works on a task.",
    });
  });
});

describe("an agent's done", () => {
  test("is heard with the branch the daemon reads, and the task moves on to review", async () => {
    const repo = folder();
    const served = await serve(repo, { socketFolder: join(folder(), "sockets"), tickMs: 10 });
    if (!served.ok) throw new Error(served.message);
    running.push(served.daemon);
    const daemon = served.daemon;
    const shipLight: Call = {
      type: "send",
      task: null,
      input: {
        type: "add",
        title: "Fix the export",
        description: null,
        plan: { intent: "ship", rigor: "light", approve: false },
      },
    };
    await send(daemon.socket, shipLight);
    const row = async () => {
      const listed = await send(daemon.socket, { type: "ls" });
      return listed.ok && listed.result.kind === "tasks" ? listed.result.tasks[0] : undefined;
    };
    await untilAsync(async () => (await row())?.state === "running");

    // The fake session runner leaves the builder's token where you can find it.
    const token = readFileSync(join(repo, ".skelcrew", "sessions", "1"), "utf8").trim();
    const done: Call = { type: "send", task: null, input: { type: "done", summary: "Fixed it." } };
    expect(await send(daemon.socket, done, token)).toEqual({
      ok: true,
      result: { kind: "sent", task: TaskId.parse(1) },
    });
    await untilAsync(async () => (await row())?.phase === "review");
    expect((await row())?.phase).toBe("review");
  });
});

async function untilAsync(done: () => Promise<boolean>): Promise<void> {
  for (let waited = 0; !(await done()) && waited < 1_000; waited += 5) await Bun.sleep(5);
}

// Waits until `done` holds, checking every few milliseconds, for a second at
// most.
async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done() && waited < 1_000; waited += 5) await Bun.sleep(5);
}

// Sends one raw line and returns the first line that comes back.
function rawLine(socket: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const connection = connect(socket, () => connection.write(line));
    let text = "";
    connection.on("data", (chunk) => {
      text += chunk.toString();
      const end = text.indexOf("\n");
      if (end >= 0) {
        connection.end();
        resolve(text.slice(0, end));
      }
    });
    connection.on("error", reject);
  });
}
