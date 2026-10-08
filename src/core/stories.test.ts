// Golden stories: whole lifecycles, one input per line, with every event they
// cause saved as a snapshot. Any change to the shape of the event log shows
// up in review. Update the snapshots only on purpose, with
// `bun test --update-snapshots`.

import { describe, expect, test } from "bun:test";
import {
  addPlanned,
  approve,
  branch,
  builder,
  changes,
  copyCreated,
  delivered,
  deliveredReport,
  done,
  mainMerged,
  pass,
  pause,
  resume,
  retry,
  run,
  sessionEnded,
  sessionStarted,
  shipped,
  start,
  stopped,
  tester,
  workspaceCreated,
} from "./testing";
import type { Input, TaskEvent } from "./types";

// Plays a story and returns every event, refusing any rejected input.
function story(...inputs: Input[]): TaskEvent[] {
  return run(...inputs).allEvents;
}

describe("golden stories", () => {
  test("a fix goes from triage through build and review to delivery", () => {
    expect(story(...shipped())).toMatchSnapshot();
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

  test("review asks for changes, the second builder is paused and resumed, then it ships", () => {
    expect(
      story(
        addPlanned("ship", "light"),
        start,
        workspaceCreated(1),
        sessionStarted(2, builder),
        done(),
        stopped(3, builder, "saved"),
        mainMerged(4),
        copyCreated(5),
        sessionStarted(6, tester),
        changes("The header row is missing a column."),
        stopped(7, tester),
        sessionStarted(8, builder),
        pause,
        stopped(9, builder, "saved"),
        resume,
        start,
        sessionStarted(10, builder),
        done(),
        stopped(11, builder, "saved"),
        mainMerged(12),
        copyCreated(13),
        sessionStarted(14, tester),
        pass(),
        stopped(15, tester),
        delivered(16),
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
