// Edge cases found in the second review of the core.

import { describe, expect, test } from "bun:test";
import { evolve } from "./evolve";
import {
  add,
  addPlanned,
  builder,
  buildRunning,
  deny,
  done,
  id,
  kill,
  pass,
  pause,
  peek,
  play,
  resume,
  reviewed,
  reviewRunning,
  run,
  sessionStarted,
  set,
  start,
  stopped,
  tester,
  workspace,
  workspaceCreated,
} from "./testing";
import type { TaskEvent } from "./types";

describe("a paused tester", () => {
  test("keeps its copy, and a resumed review starts the tester in it", () => {
    const paused = play(reviewRunning().task, [pause]);
    const stop = paused.commands[0];
    expect(stop?.type === "stop_session" && stop.remove).toBeNull();

    const { task, commands } = play(paused.task, [stopped(9, tester), resume, start]);
    expect(task.phase === "review" && task.copy?.path).toBe("/repo/.skelcrew/review/142");
    expect(commands[0]?.type).toBe("start_session");
  });
});

describe("a resumed task", () => {
  test("goes to the front of the line once, not every time it waits after", () => {
    const { task } = play(buildRunning().task, [
      pause,
      stopped(5, builder, "saved"),
      resume,
      start,
    ]);

    expect(task.lane).toBe("queued");
  });
});

describe("your sign-off on a held task", () => {
  const heldAwaiting = () =>
    play(reviewRunning({ intent: "ship", rigor: "full", approve: true }).task, [
      pass(),
      stopped(9, tester),
      pause,
    ]).task;

  test("deny waits until you resume it, like approve", () => {
    expect(peek(heldAwaiting(), deny())).toEqual({
      ok: false,
      rejection: { input: "deny", reason: "#142 is held. Resume it first." },
    });
  });

  test("changing rigor doesn't, when nothing lifts the approval", () => {
    const critical = { head: reviewed.head, changedFiles: ["src/auth/token.ts"] };
    const awaiting = play(reviewRunning(undefined, critical).task, [
      pass(),
      stopped(9, tester),
      pause,
    ]).task;

    expect(peek(awaiting, set({ rigor: "light" })).ok).toBe(true);
  });
});

describe("a stop's reply", () => {
  test("saying a save failed, for a stop that didn't save, changes nothing about saving", () => {
    const delivering = play(reviewRunning().task, [pass()]).task;
    const { task } = play(delivering, [stopped(9, tester, "save_failed")]);

    expect(task.hold).toBeNull();
    expect(task.phase === "review" && task.step).toEqual({ kind: "delivering", request: 10 });
  });

  test("for another session than the one stopping changes nothing", () => {
    const stopping = play(buildRunning().task, [done()]).task;

    expect(peek(stopping, stopped(5, tester, "saved"))).toEqual({
      ok: true,
      events: [],
      commands: [],
    });
  });
});

describe("killing while a session starts", () => {
  test("keeps the workspace, and saves the late session's work when it is stopped", () => {
    const { task, commands } = run(addPlanned(), start, workspaceCreated(1), kill);

    expect(commands).toEqual([]);
    expect(task.phase === "ended" && task.kept).toEqual(workspace);
    const late = peek(task, sessionStarted(2, builder));
    expect(late.ok && late.commands[0]?.type === "stop_session" && late.commands[0].save).toBe(
      true,
    );
  });
});

describe("set", () => {
  test("with nothing to change is refused", () => {
    expect(peek(run(add()).task, set({}))).toEqual({
      ok: false,
      rejection: { input: "set", reason: "Set intent, rigor or approval." },
    });
  });
});

describe("a damaged log", () => {
  test("stops replay: evolve refuses an event that doesn't fit", () => {
    const { task } = run(add());
    const misplaced: TaskEvent = {
      v: 1,
      taskId: id,
      at: 0,
      type: "review.passed",
      commit: reviewed.head,
      evidence: "",
    };

    expect(evolve(task, misplaced).ok).toBe(false);
  });
});
