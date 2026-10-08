import { describe, expect, test } from "bun:test";
import {
  add,
  builder,
  id,
  kill,
  planner,
  run,
  sessionStarted,
  shipped,
  start,
  workspaceCreated,
} from "../core/testing";
import { parseCommand } from "./schema";

// Every command a whole lifecycle sends, through triage, build, review,
// delivery and a kill.
const sent = [
  ...run(...shipped("# Spec")).allCommands,
  ...run(add(), start, workspaceCreated(1), sessionStarted(2, planner), kill).allCommands,
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
