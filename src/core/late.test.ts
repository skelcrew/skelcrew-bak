import { describe, expect, test } from "bun:test";
import {
  add,
  builder,
  buildRunning,
  copy,
  copyCreated,
  done,
  id,
  kill,
  mainFailed,
  mainMerged,
  pass,
  peek,
  planner,
  play,
  reviewRunning,
  run,
  sessionStarted,
  start,
  stopped,
  tester,
  workspace,
  workspaceCreated,
} from "./testing";

describe("a late reply", () => {
  test("for a workspace the task no longer waits on is removed", () => {
    const { task } = run(add(), start, kill);

    expect(peek(task, workspaceCreated(1))).toEqual({
      ok: true,
      events: [],
      commands: [{ type: "remove_workspace", path: workspace.path, deleteBranch: false }],
    });
  });

  test("for a session the task no longer waits on is stopped, saving any work it did", () => {
    const { task } = run(add(), start, workspaceCreated(1), kill);

    expect(peek(task, sessionStarted(2, planner))).toEqual({
      ok: true,
      events: [],
      commands: [
        {
          type: "stop_session",
          taskId: id,
          request: null,
          session: planner,
          save: true,
          remove: null,
        },
      ],
    });
  });

  test("for a tester's copy after the task was killed is removed", () => {
    const { task } = play(buildRunning().task, [
      done(),
      stopped(5, builder, "saved"),
      mainMerged(6),
      kill,
    ]);

    expect(peek(task, copyCreated(7))).toEqual({
      ok: true,
      events: [],
      commands: [{ type: "remove_workspace", path: copy.path, deleteBranch: false }],
    });
  });
});

describe("a repeated reply", () => {
  test("for the session the task already runs is ignored", () => {
    const { task } = buildRunning();

    expect(peek(task, sessionStarted(4, builder))).toEqual({ ok: true, events: [], commands: [] });
  });

  test("for the workspace the task already holds is ignored", () => {
    const { task } = buildRunning();

    expect(peek(task, workspaceCreated(1))).toEqual({ ok: true, events: [], commands: [] });
  });
});

describe("rule 5: a late reply changes nothing", () => {
  test("is accepted with nothing to do, not refused", () => {
    const failed = play(buildRunning().task, [done(), stopped(5, builder, "saved"), mainFailed(6)]);

    expect(peek(failed.task, mainMerged(6))).toEqual({ ok: true, events: [], commands: [] });
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
