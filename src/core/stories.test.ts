// Golden stories: whole lifecycles, one input per line, with every event they
// cause saved as a snapshot. Any change to the shape of the event log shows
// up in review. Update the snapshots only on purpose, with
// `bun test --update-snapshots`.

import { describe, expect, test } from "bun:test";
import { decide } from "./decide";
import { evolve } from "./evolve";
import {
  add,
  addPlanned,
  approve,
  branch,
  builder,
  config,
  copyCreated,
  delivered,
  deliveredReport,
  done,
  id,
  mainMerged,
  pass,
  planner,
  proceed,
  retry,
  sessionEnded,
  sessionStarted,
  start,
  stopped,
  tester,
  workspaceCreated,
} from "./testing";
import type { Input, Task, TaskEvent } from "./types";

// Plays a story and returns every event, refusing any rejected input.
function story(...inputs: Input[]): TaskEvent[] {
  let task: Task | null = null;
  const log: TaskEvent[] = [];
  for (const [i, input] of inputs.entries()) {
    const decision = decide(task, { taskId: id, at: 1_000 + i, input }, config);
    if (!decision.ok) throw new Error(`Rejected ${input.type}: ${decision.rejection.reason}`);
    for (const event of decision.events) {
      const evolved = evolve(task, event);
      if (!evolved.ok) throw new Error(evolved.reason);
      task = evolved.task;
      log.push(event);
    }
  }
  return log;
}

describe("golden stories", () => {
  test("a fix goes from triage through build and review to delivery", () => {
    expect(
      story(
        add("Fix empty export"),
        start,
        workspaceCreated(1),
        sessionStarted(2, planner),
        proceed(),
        stopped(3, planner),
        sessionStarted(4, builder),
        done(),
        stopped(5, builder, "saved"),
        mainMerged(6),
        copyCreated(7),
        sessionStarted(8, tester),
        pass(),
        stopped(9, tester),
        delivered(10),
      ),
    ).toMatchSnapshot();
  });

  test("a flagged fix waits for your sign-off", () => {
    expect(
      story(
        addPlanned("ship", "full", true),
        start,
        workspaceCreated(1),
        sessionStarted(2, builder),
        done(),
        stopped(3, builder, "saved"),
        mainMerged(4),
        copyCreated(5),
        sessionStarted(6, tester),
        pass(),
        stopped(7, tester),
        approve,
        delivered(8),
      ),
    ).toMatchSnapshot();
  });

  test("an answer hands over a report with a proposed task", () => {
    expect(
      story(
        addPlanned("answer", "light"),
        start,
        workspaceCreated(1),
        sessionStarted(2, builder),
        {
          by: "agent",
          session: builder,
          type: "done_answer",
          report: "Search is slow because of N+1 queries.",
          proposals: [{ title: "Batch the queries", description: "In search." }],
          branch,
        },
        stopped(3, builder),
        copyCreated(4, branch.head),
        sessionStarted(5, tester),
        pass(),
        stopped(6, tester),
        deliveredReport(7),
      ),
    ).toMatchSnapshot();
  });

  test("a try is delivered straight after its merge", () => {
    expect(
      story(
        addPlanned("try", "light"),
        start,
        workspaceCreated(1),
        sessionStarted(2, builder),
        done(),
        stopped(3, builder, "saved"),
        mainMerged(4),
        delivered(5),
      ),
    ).toMatchSnapshot();
  });

  test("a crashed builder holds the task, and a retry starts a fresh one", () => {
    expect(
      story(
        addPlanned("ship", "light"),
        start,
        workspaceCreated(1),
        sessionStarted(2, builder),
        sessionEnded(2, builder, 137, "Killed"),
        retry,
        start,
        sessionStarted(3, builder),
      ),
    ).toMatchSnapshot();
  });
});
