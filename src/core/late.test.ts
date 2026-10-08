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
  mainMerged,
  peek,
  planner,
  play,
  run,
  sessionStarted,
  start,
  stopped,
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
