import { describe, expect, test } from "bun:test";
import {
  add,
  addPlanned,
  builder,
  copyCreated,
  delivered,
  done,
  id,
  mainMerged,
  pass,
  planner,
  play,
  proceed,
  sessionStarted,
  start,
  stopped,
  tester,
  workspaceCreated,
} from "../core/testing";
import type { Input, Task, TaskEvent } from "../core/types";
import { parseTaskEvent } from "./schema";

// Every event of whole lifecycles, through triage, build, review and delivery.
function lifecycle(inputs: Input[]): TaskEvent[] {
  const all: TaskEvent[] = [];
  let task: Task | null = null;
  for (const input of inputs) {
    const step = play(task, [input]);
    all.push(...step.events);
    task = step.task;
  }
  return all;
}

const shipped = lifecycle([
  add(),
  start,
  workspaceCreated(1),
  sessionStarted(2, planner),
  proceed("# Spec"),
  stopped(3, planner),
  { by: "plugin", type: "spec_committed", request: 4, path: "docs/plans/142.md" },
  sessionStarted(5, builder),
  done(),
  stopped(6, builder, "saved"),
  mainMerged(7),
  copyCreated(8),
  sessionStarted(9, tester),
  pass(),
  stopped(10, tester),
  delivered(11),
]);

describe("the event schema", () => {
  test("reads back every event of a whole lifecycle exactly as written", () => {
    for (const event of [...shipped, ...lifecycle([addPlanned("try", "light")])]) {
      const stored = JSON.parse(JSON.stringify(event));
      expect(parseTaskEvent(stored)).toEqual({ ok: true, value: event });
    }
  });

  test("refuses an unknown field, rather than dropping it", () => {
    const [received] = shipped;
    expect(parseTaskEvent({ ...received, extra: 1 }).ok).toBe(false);
  });

  test("refuses a missing field", () => {
    expect(parseTaskEvent({ v: 1, taskId: id, at: 0, type: "task.held" }).ok).toBe(false);
  });

  test("refuses an event type it doesn't know", () => {
    expect(parseTaskEvent({ v: 1, taskId: id, at: 0, type: "task.teleported" }).ok).toBe(false);
  });

  test("refuses another version", () => {
    const [received] = shipped;
    expect(parseTaskEvent({ ...received, v: 2 }).ok).toBe(false);
  });
});
