import { describe, expect, test } from "bun:test";
import { TaskId } from "../core/ids";
import type { WireInput } from "../protocol/protocol";
import { readArgs } from "./args";

const task = TaskId.parse(142);

describe("your commands", () => {
  test("add, going through triage", () => {
    expect(readArgs(["add", "Fix the button colour"])).toEqual({
      ok: true,
      call: {
        type: "send",
        task: null,
        input: { type: "add", title: "Fix the button colour", description: null, plan: null },
      },
    });
  });

  test("add, skipping triage with an intent and a rigor", () => {
    expect(
      readArgs(["add", "Fix it", "--try", "--full", "--approve", "--description", "Why"]),
    ).toEqual({
      ok: true,
      call: {
        type: "send",
        task: null,
        input: {
          type: "add",
          title: "Fix it",
          description: "Why",
          plan: { intent: "try", rigor: "full", approve: true },
        },
      },
    });
  });

  test("add with only half a plan is refused, saying what is missing", () => {
    expect(readArgs(["add", "Fix it", "--ship"])).toEqual({
      ok: false,
      message:
        "To skip triage, give both an intent (--ship, --try or --answer) and a rigor (--light or --full).",
    });
  });

  test("ls", () => {
    expect(readArgs(["ls"])).toEqual({ ok: true, call: { type: "ls" } });
  });

  test("set changes only what it names", () => {
    expect(readArgs(["set", "142", "--rigor", "full"])).toEqual({
      ok: true,
      call: {
        type: "send",
        task,
        input: { type: "set", intent: null, rigor: "full", approve: null },
      },
    });
    expect(readArgs(["set", "142", "--no-approve"])).toEqual({
      ok: true,
      call: {
        type: "send",
        task,
        input: { type: "set", intent: null, rigor: null, approve: false },
      },
    });
  });

  test("reply, approve and deny", () => {
    expect(readArgs(["reply", "142", "No, skip archived items"])).toEqual({
      ok: true,
      call: { type: "send", task, input: { type: "reply", text: "No, skip archived items" } },
    });
    expect(readArgs(["approve", "142"])).toEqual({
      ok: true,
      call: { type: "send", task, input: { type: "approve" } },
    });
    expect(readArgs(["deny", "142", "Too risky"])).toEqual({
      ok: true,
      call: { type: "send", task, input: { type: "deny", note: "Too risky" } },
    });
  });

  test("pause, resume, start, retry and kill", () => {
    const inputs: [string, WireInput][] = [
      ["pause", { type: "pause" }],
      ["resume", { type: "resume" }],
      ["start", { type: "start_now" }],
      ["retry", { type: "retry" }],
      ["kill", { type: "kill" }],
    ];
    for (const [command, input] of inputs) {
      expect(readArgs([command, "142"])).toEqual({ ok: true, call: { type: "send", task, input } });
    }
  });

  test("a task can be given as #142", () => {
    expect(readArgs(["kill", "#142"])).toEqual({
      ok: true,
      call: { type: "send", task, input: { type: "kill" } },
    });
  });
});

describe("a command that can't be read", () => {
  test("is refused when unknown", () => {
    expect(readArgs(["launch", "142"])).toEqual({
      ok: false,
      message: "There is no `skel launch`. Run `skel help` for the commands.",
    });
  });

  test("is refused without its task", () => {
    expect(readArgs(["kill"])).toEqual({
      ok: false,
      message: "Say which task, as in `skel kill 142`.",
    });
  });

  test("is refused with a task that isn't a number", () => {
    expect(readArgs(["kill", "soon"])).toEqual({
      ok: false,
      message: "soon isn't a task number.",
    });
  });

  test("is refused with an option it doesn't take", () => {
    const read = readArgs(["kill", "142", "--force"]);

    expect(read.ok).toBe(false);
    expect(!read.ok && read.message).toContain("--force");
  });

  test("is refused when its text is missing", () => {
    expect(readArgs(["reply", "142"])).toEqual({
      ok: false,
      message: 'Say what to reply, as in `skel reply 142 "text"`.',
    });
  });
});
