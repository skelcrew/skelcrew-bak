import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { TaskId } from "../core/ids";
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
