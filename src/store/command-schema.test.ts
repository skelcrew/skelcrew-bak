import { describe, expect, test } from "bun:test";
import {
  add,
  builder,
  copyCreated,
  delivered,
  done,
  id,
  kill,
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
import type { Command, Input, Task } from "../core/types";
import { parseCommand } from "./schema";

// Every command a whole lifecycle sends, through triage, build, review,
// delivery and a kill.
function commands(inputs: Input[]): Command[] {
  const all: Command[] = [];
  let task: Task | null = null;
  for (const input of inputs) {
    const step = play(task, [input]);
    all.push(...step.commands);
    task = step.task;
  }
  return all;
}

const sent = [
  ...commands([
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
  ]),
  ...commands([add(), start, workspaceCreated(1), sessionStarted(2, planner), kill]),
];

describe("the command schema", () => {
  test("reads back every command a lifecycle sends, exactly as written", () => {
    const types = new Set(sent.map((command) => command.type));
    expect(types.size).toBeGreaterThanOrEqual(8);
    for (const command of sent) {
      const stored = JSON.parse(JSON.stringify(command));
      expect(parseCommand(stored)).toEqual({ ok: true, value: command });
    }
  });

  test("refuses an unknown field", () => {
    const stop = {
      type: "stop_session",
      taskId: id,
      request: 1,
      session: builder,
      save: true,
      remove: null,
    };
    expect(parseCommand(stop).ok).toBe(true);
    expect(parseCommand({ ...stop, extra: 1 }).ok).toBe(false);
  });

  test("refuses a command type it doesn't know", () => {
    expect(parseCommand({ type: "launch_rockets", taskId: id }).ok).toBe(false);
  });
});
