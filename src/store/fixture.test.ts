// Saved events in today's shape, which must always read back. The log is
// kept forever, so a change to an event's shape must still read these. See
// "Saved events" in AGENTS.md for when the file may be regenerated.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evolve } from "../core/evolve";
import type { Task, TaskEvent, TaskId } from "../core/types";
import { parseTaskEvent } from "./schema";

const lines = readFileSync(join(import.meta.dir, "fixtures/v1-events.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "");

test("every saved event still reads back, and rebuilds its task", () => {
  const tasks = new Map<TaskId, Task>();
  for (const [i, line] of lines.entries()) {
    const parsed = parseTaskEvent(JSON.parse(line));
    if (!parsed.ok) throw new Error(`Line ${i + 1}: ${parsed.reason}`);
    const event: TaskEvent = parsed.value;
    const evolved = evolve(tasks.get(event.taskId) ?? null, event);
    if (!evolved.ok) throw new Error(`Line ${i + 1}: ${evolved.reason}`);
    tasks.set(event.taskId, evolved.task);
  }
  expect(tasks.size).toBeGreaterThan(0);
});
