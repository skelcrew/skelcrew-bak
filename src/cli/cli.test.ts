import { describe, expect, test } from "bun:test";
import { TaskId } from "../core/ids";
import type { Sent } from "../daemon/client";
import type { Call } from "../protocol/protocol";
import { run } from "./cli";

// Runs `skel` with a daemon that answers `answer`, and returns what it
// printed and its exit code.
async function skel(args: string[], answer: Sent, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: { call: Call; token: string | null }[] = [];
  const code = await run(args, {
    env,
    send: async (call, token) => {
      sent.push({ call, token });
      return answer;
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out, err, sent };
}

const sentTo = (task: number): Sent => ({
  ok: true,
  result: { kind: "sent", task: TaskId.parse(task) },
});

describe("skel", () => {
  test("says which task it added", async () => {
    const { code, out } = await skel(["add", "Fix the export"], sentTo(1));

    expect(code).toBe(0);
    expect(out).toEqual(["Added #1."]);
  });

  test("says what it did to a task", async () => {
    expect((await skel(["pause", "142"], sentTo(142))).out).toEqual(["Paused #142."]);
    expect((await skel(["kill", "142"], sentTo(142))).out).toEqual(["Killed #142."]);
  });

  test("lists the tasks, one per line", async () => {
    const { out } = await skel(["ls"], {
      ok: true,
      result: {
        kind: "tasks",
        tasks: [
          {
            task: TaskId.parse(1),
            title: "Fix the export",
            phase: "triage",
            intent: null,
            rigor: null,
            state: "running",
          },
          {
            task: TaskId.parse(12),
            title: "Add dark mode",
            phase: "build",
            intent: "ship",
            rigor: "full",
            state: "held",
          },
        ],
      },
    });

    expect(out).toEqual([
      "#1   triage  -           running  Fix the export",
      "#12  build   ship, full  held     Add dark mode",
    ]);
  });

  test("says so when there are no tasks", async () => {
    const { out } = await skel(["ls"], { ok: true, result: { kind: "tasks", tasks: [] } });

    expect(out).toEqual(["No tasks."]);
  });

  test("prints a refusal and fails", async () => {
    const { code, out, err } = await skel(["pause", "142"], {
      ok: false,
      message: "#142 is already paused.",
    });

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["#142 is already paused."]);
  });

  test("prints why it can't read its arguments, and sends nothing", async () => {
    const { code, err, sent } = await skel(["kill"], sentTo(1));

    expect(code).toBe(1);
    expect(err).toEqual(["Say which task, as in `skel kill 142`."]);
    expect(sent).toEqual([]);
  });

  test("help lists the commands, and sends nothing", async () => {
    for (const args of [["help"], []]) {
      const { code, out, sent } = await skel(args, sentTo(1));

      expect(code).toBe(0);
      expect(out.join("\n")).toContain("skel add");
      expect(out.join("\n")).toContain("skel kill");
      expect(sent).toEqual([]);
    }
  });

  test("sends the session's token from SKELCREW_SESSION, or none", async () => {
    const mine = await skel(["ls"], { ok: true, result: { kind: "tasks", tasks: [] } });
    const agent = await skel(
      ["ls"],
      { ok: true, result: { kind: "tasks", tasks: [] } },
      {
        SKELCREW_SESSION: "s-1-2.abc",
      },
    );

    expect(mine.sent[0]?.token).toBeNull();
    expect(agent.sent[0]?.token).toBe("s-1-2.abc");
  });
});
