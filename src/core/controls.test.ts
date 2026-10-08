import { describe, expect, test } from "bun:test";
import {
  add,
  builder,
  buildRunning,
  done,
  id,
  kill,
  mainFailed,
  pause,
  peek,
  planner,
  play,
  resume,
  retry,
  run,
  sessionFailed,
  start,
  startNow,
  stopped,
  triageRunning,
  types,
  usage,
  workspace,
  workspaceCreated,
} from "./testing";
import type { Input } from "./types";

describe("pausing", () => {
  test("stops a working builder, saving its work, and holds the task", () => {
    const { task, events, commands } = play(buildRunning().task, [pause]);

    expect(types(events)).toEqual(["task.held", "session.stopping"]);
    expect(commands).toEqual([
      { type: "stop_session", taskId: id, request: 5, session: builder, save: true, remove: null },
    ]);
    expect(task.hold).toEqual({ kind: "paused" });
    expect(task.phase === "build" && task.step).toEqual({ kind: "queued" });
  });

  test("stops a planner without saving, since it can't edit", () => {
    const { commands } = play(triageRunning().task, [pause]);

    expect(commands[0]?.type === "stop_session" && commands[0].save).toBe(false);
  });

  test("holds a queued task with nothing to stop", () => {
    const { task, commands } = run(add(), pause);

    expect(commands).toEqual([]);
    expect(task.hold).toEqual({ kind: "paused" });
  });

  test("waits while a step is under way, such as a workspace being made", () => {
    const { task } = run(add(), start);

    expect(peek(task, pause)).toEqual({
      ok: false,
      rejection: {
        input: "pause",
        reason: "#142 is busy with a step. skel pause waits until it settles.",
      },
    });
  });

  test("is refused for a task that is already held", () => {
    const { task } = run(add(), pause);

    expect(peek(task, pause)).toEqual({
      ok: false,
      rejection: { input: "pause", reason: "#142 is already held." },
    });
  });

  test("keeps a held task from starting", () => {
    const { task } = run(add(), pause);

    expect(peek(task, start)).toEqual({
      ok: false,
      rejection: { input: "start", reason: "#142 is held." },
    });
  });
});

describe("resuming", () => {
  test("lifts your pause, and the task goes ahead of other queued work", () => {
    const { task, events } = play(buildRunning().task, [pause, resume]);

    expect(types(events)).toEqual(["task.released"]);
    expect(task.hold).toBeNull();
    expect(task.lane).toBe("resumed");
  });

  test("carries on with work already handed over, instead of building again", () => {
    const { events } = play(buildRunning().task, [
      done(),
      stopped(5, builder, "save_failed"),
      retry,
      start,
    ]);

    expect(types(events)).toEqual(["main.requested"]);
  });

  test("is refused for a task held by a failure, which retry lifts", () => {
    const { task } = run(add(), start, workspaceCreated(1), sessionFailed(2));

    expect(peek(task, resume)).toEqual({
      ok: false,
      rejection: { input: "resume", reason: "#142 isn't paused. Retry it instead." },
    });
  });
});

describe("retrying", () => {
  test("lifts a hold, and the task waits for a slot", () => {
    const { task, events } = play(run(add(), start, workspaceCreated(1), sessionFailed(2)).task, [
      retry,
    ]);

    expect(types(events)).toEqual(["task.released"]);
    expect(task.hold).toBeNull();
    expect(task.phase === "triage" && task.step).toEqual({ kind: "queued" });
  });

  test("puts a failed merge back in line, and the next start sends it again", () => {
    const failed = play(buildRunning().task, [done(), stopped(5, builder, "saved"), mainFailed(6)]);
    const retried = play(failed.task, [retry]);
    expect(types(retried.events)).toEqual(["task.released"]);

    const { events, commands } = play(retried.task, [start]);
    expect(types(events)).toEqual(["main.requested"]);
    expect(commands).toEqual([{ type: "merge_main", taskId: id, request: 7, workspace }]);
  });

  test("is refused for a paused task, which resume lifts", () => {
    const { task } = run(add(), pause);

    expect(peek(task, retry)).toEqual({
      ok: false,
      rejection: { input: "retry", reason: "#142 is paused. Resume it instead." },
    });
  });

  test("is refused for a task that isn't held", () => {
    expect(peek(run(add()).task, retry)).toEqual({
      ok: false,
      rejection: { input: "retry", reason: "#142 isn't held." },
    });
  });
});

describe("killing", () => {
  test("ends a working task, stopping its agent and removing its workspace once saved", () => {
    const { task, events, commands } = play(buildRunning().task, [kill]);

    expect(types(events)).toEqual(["task.killed", "session.stopping"]);
    expect(commands).toEqual([
      {
        type: "stop_session",
        taskId: id,
        request: 5,
        session: builder,
        save: true,
        remove: { path: workspace.path, deleteBranch: false },
      },
    ]);
    expect(task.phase === "ended" && task.outcome).toEqual({ kind: "killed" });
    expect(task.phase === "ended" && task.kept).toEqual(workspace);
  });

  test("keeps the workspace when the save fails, so no work is lost", () => {
    const { task } = play(buildRunning().task, [kill, stopped(5, builder, "save_failed")]);

    expect(task.phase === "ended" && task.kept).toEqual(workspace);
  });

  test("lets go of the workspace once the stop removed it", () => {
    const { task } = play(buildRunning().task, [kill, stopped(5, builder, "saved")]);

    expect(task.phase === "ended" && task.kept).toBeNull();
  });

  test("removes the workspace of a task with no agent", () => {
    const queued = play(buildRunning().task, [pause, stopped(5, builder, "saved")]).task;
    const { events, commands } = play(queued, [kill]);

    expect(types(events)).toEqual(["task.killed", "workspace.removed"]);
    expect(commands).toEqual([
      { type: "remove_workspace", path: workspace.path, deleteBranch: false },
    ]);
  });

  test("is refused for a task that has ended", () => {
    const { task } = run(add(), kill);

    expect(peek(task, kill)).toEqual({
      ok: false,
      rejection: { input: "kill", reason: "#142 has ended." },
    });
  });
});

describe("starting now", () => {
  test("starts the task like the scheduler would, and says it was you", () => {
    const { events } = run(add(), startNow);

    expect(types(events)).toEqual(["task.started_now", "workspace.requested"]);
  });

  test("is refused for a held task", () => {
    const { task } = run(add(), pause);

    expect(peek(task, startNow)).toEqual({
      ok: false,
      rejection: { input: "start_now", reason: "#142 is held." },
    });
  });
});

describe("an agent", () => {
  test("giving up holds the task and stops it", () => {
    const giveUp: Input = {
      by: "agent",
      session: builder,
      type: "give_up",
      message: "Needs a database I can't reach.",
    };
    const { task, events } = play(buildRunning().task, [giveUp]);

    expect(types(events)).toEqual(["task.held", "session.stopping"]);
    expect(task.hold).toEqual({ kind: "gave_up", message: "Needs a database I can't reach." });
  });

  test("reporting progress records it and changes nothing else", () => {
    const progress: Input = {
      by: "agent",
      session: planner,
      type: "progress",
      text: "Found the CSV writer.",
    };
    const before = triageRunning().task;
    const { task, events } = play(before, [progress]);

    expect(types(events)).toEqual(["agent.progress"]);
    expect(task).toEqual(before);
  });
});

describe("usage", () => {
  test("is kept per session, and a task's usage is their sum", () => {
    const { task } = play(buildRunning().task, [usage(planner, 1_000), usage(builder, 5_000)]);

    expect(task.usage).toEqual({
      [planner]: { tokens: 1_000, cacheReads: 0, workingMs: 60_000 },
      [builder]: { tokens: 5_000, cacheReads: 0, workingMs: 60_000 },
    });
  });

  test("is refused when lower than that session's last report, since it is older", () => {
    const { task } = play(buildRunning().task, [usage(builder, 5_000)]);

    expect(peek(task, usage(builder, 4_000))).toEqual({
      ok: false,
      rejection: {
        input: "usage",
        reason: "This usage report for session-builder is older than the last one.",
      },
    });
  });

  test("is still recorded after the task has ended", () => {
    const { task } = play(buildRunning().task, [kill, usage(builder, 9_000)]);

    expect(task.usage[builder]?.tokens).toBe(9_000);
  });
});

describe("a change in the tracker", () => {
  test("is refused, since tasks move only through Skelcrew", () => {
    const outside: Input = { by: "plugin", type: "outside_change", what: "issue closed" };

    expect(peek(run(add()).task, outside)).toEqual({
      ok: false,
      rejection: {
        input: "outside_change",
        reason: "Tasks move only through Skelcrew. The issue closed in the tracker was ignored.",
      },
    });
  });
});
