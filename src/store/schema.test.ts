import { describe, expect, test } from "bun:test";
import { addPlanned, id, run, shipped } from "../core/testing";
import { parseTaskEvent } from "./schema";

// Every event of whole lifecycles, through triage, build, review and delivery.
const shippedEvents = run(...shipped("# Spec")).allEvents;

describe("the event schema", () => {
  test("reads back every event of a whole lifecycle exactly as written", () => {
    for (const event of [...shippedEvents, ...run(addPlanned("try", "light")).allEvents]) {
      const stored = JSON.parse(JSON.stringify(event));
      expect(parseTaskEvent(stored)).toEqual({ ok: true, value: event });
    }
  });

  test("refuses an unknown field, rather than dropping it", () => {
    const [received] = shippedEvents;
    expect(parseTaskEvent({ ...received, extra: 1 }).ok).toBe(false);
  });

  test("refuses a missing field", () => {
    expect(parseTaskEvent({ v: 1, taskId: id, at: 0, type: "task.held" }).ok).toBe(false);
  });

  test("refuses an event type it doesn't know", () => {
    expect(parseTaskEvent({ v: 1, taskId: id, at: 0, type: "task.teleported" }).ok).toBe(false);
  });

  test("refuses another version", () => {
    const [received] = shippedEvents;
    expect(parseTaskEvent({ ...received, v: 2 }).ok).toBe(false);
  });
});
