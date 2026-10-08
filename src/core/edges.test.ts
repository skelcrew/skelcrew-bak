// Edge cases found in review of the core. Each test names the rule it
// protects, from docs/invariants.md.

import { describe, expect, test } from "bun:test";
import { decide } from "./decide";
import { TaskId } from "./ids";
import { slotsInUse } from "./schedule";
import {
  approve,
  ask,
  attach,
  branch,
  builder,
  buildRunning,
  config,
  copy,
  copyCreated,
  delivered,
  done,
  doneAnswer,
  id,
  kill,
  mainFailed,
  mainMerged,
  next,
  pass,
  pause,
  planner,
  play,
  retry,
  reviewed,
  reviewRunning,
  sessionStarted,
  set,
  sha,
  start,
  stopped,
  tester,
  triageRunning,
  types,
  workspace,
} from "./testing";
import type { Input } from "./types";

describe("rule 6: one reviewed commit", () => {
  test("a tester's copy of another commit isn't reviewed, and is removed", () => {
    const merged = play(buildRunning().task, [done(), stopped(5, builder, "saved"), mainMerged(6)]);
    const wrong: Input = {
      by: "plugin",
      type: "copy_created",
      request: 7,
      copy: { path: copy.path, commit: sha("e") },
    };
    const { task, commands } = play(merged.task, [wrong]);

    expect(task.hold?.kind).toBe("failed");
    expect(commands).toEqual([{ type: "remove_workspace", path: copy.path, deleteBranch: false }]);
  });

  test("a delivery of another commit holds the task instead of ending it", () => {
    const delivering = play(reviewRunning().task, [pass()]).task;
    const { task } = play(delivering, [delivered(10, sha("e"))]);

    expect(task.phase).toBe("review");
    expect(task.hold).toEqual({
      kind: "failed",
      step: "delivery",
      message: `Delivered ${sha("e")}, but the reviewed commit is ${reviewed.head}.`,
    });
  });

  test("an answer's delivery must be its report, not a branch", () => {
    const answering = play(
      buildRunning({ intent: "answer", rigor: "light", approve: false }).task,
      [
        doneAnswer(),
        stopped(5, builder),
        copyCreated(6, branch.head),
        sessionStarted(7, tester),
        pass(),
      ],
    ).task;
    const { task } = play(answering, [delivered(9, branch.head)]);

    expect(task.hold?.kind).toBe("failed");
  });
});

describe("rule 10: max_running", () => {
  test("a retried merge waits for a slot instead of starting at once", () => {
    const failed = play(buildRunning().task, [done(), stopped(5, builder, "saved"), mainFailed(6)]);
    const { task, commands } = play(failed.task, [retry]);

    expect(commands).toEqual([]);
    expect(slotsInUse([task], 0)).toBe(0);
    const { events } = play(task, [start]);
    expect(types(events)).toEqual(["main.requested"]);
  });

  test("an attached task keeps its slot even while its agent asks you something", () => {
    const { task } = play(buildRunning().task, [attach, ask(builder)]);

    expect(slotsInUse([task], 0)).toBe(1);
  });
});

describe("rule 15: work is saved before it is let go", () => {
  test("a workspace whose save failed survives a later kill", () => {
    const { task, commands } = play(buildRunning().task, [
      pause,
      stopped(5, builder, "save_failed"),
      kill,
    ]);

    expect(commands).toEqual([]);
    expect(task.phase === "ended" && task.kept).toEqual(workspace);
  });

  test("a repeated start reply for an agent being stopped is ignored", () => {
    const stopping = play(buildRunning().task, [done()]).task;

    expect(next(stopping, sessionStarted(4, builder))).toEqual({
      ok: true,
      events: [],
      commands: [],
    });
  });
});

describe("waiting while an agent stops", () => {
  test("pause waits until the stop is confirmed", () => {
    const stopping = play(buildRunning().task, [done()]).task;

    expect(next(stopping, pause)).toEqual({
      ok: false,
      rejection: {
        input: "pause",
        reason: "#142 is busy with a step. skel pause waits until it settles.",
      },
    });
  });
});

describe("approval on a held task", () => {
  test("waits until you resume it", () => {
    const awaiting = play(reviewRunning({ intent: "ship", rigor: "full", approve: true }).task, [
      pass(),
      stopped(9, tester),
      pause,
    ]).task;

    expect(next(awaiting, approve)).toEqual({
      ok: false,
      rejection: { input: "approve", reason: "#142 is held. Resume it first." },
    });
    expect(next(awaiting, set({ approve: false })).ok).toBe(false);
  });
});

describe("rule 23: every event belongs to its task", () => {
  test("an input for another task number is refused", () => {
    const { task } = triageRunning();
    const decision = decide(task, { taskId: TaskId.parse(7), at: 0, input: pause }, config);

    expect(decision).toEqual({
      ok: false,
      rejection: { input: "pause", reason: "This input is for #7, but the task is #142." },
    });
  });
});

describe("an ended task", () => {
  test("keeps what was handed over", () => {
    const { task } = play(reviewRunning().task, [pass(), stopped(9, tester), delivered(10)]);

    expect(task.phase === "ended" && task.handover?.text).toBe(
      "Empty reports now export a header row.",
    );
  });
});

describe("rule 5: a late reply changes nothing", () => {
  test("is accepted with nothing to do, not refused", () => {
    const failed = play(buildRunning().task, [done(), stopped(5, builder, "saved"), mainFailed(6)]);

    expect(next(failed.task, mainMerged(6))).toEqual({ ok: true, events: [], commands: [] });
  });
});

void [planner, id];
