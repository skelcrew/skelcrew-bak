import { describe, expect, test } from "bun:test";
import { TaskId } from "../core/ids";
import { add, config, id, kill, start } from "../core/testing";
import type { Command } from "../core/types";
import { EventStore } from "../store/store";
import { type Log, Loop, type Tools } from "./loop";

// Tools that only remember what they were handed.
function recording(): Tools & { handed: Command[] } {
  const handed: Command[] = [];
  return { handed, carryOut: (command) => handed.push(command) };
}

describe("sending an input", () => {
  test("saves its events and commands, applies them, then hands the commands out", () => {
    const store = EventStore.open(":memory:");
    const tools = recording();
    const loop = new Loop(config, tools, store);

    loop.send(id, add(), 1_000);
    const decision = loop.send(id, start, 2_000);

    expect(decision.ok).toBe(true);
    const task = loop.task(id);
    expect(task?.phase === "triage" && task.step).toEqual({
      kind: "creating_workspace",
      request: 1,
    });
    expect(tools.handed).toEqual([{ type: "create_workspace", taskId: id, request: 1 }]);
    const saved = store.loadTasks();
    if (!saved.ok || task === null) throw new Error("nothing saved");
    expect(saved.tasks.get(id)).toEqual(task);
    expect(store.loadCommands()).toEqual({
      ok: true,
      commands: [{ id: 1, command: { type: "create_workspace", taskId: id, request: 1 } }],
    });
  });

  test("that is rejected changes nothing", () => {
    const tools = recording();
    const loop = new Loop(config, tools, EventStore.open(":memory:"));

    expect(loop.send(id, start, 1_000).ok).toBe(false);
    expect(loop.task(id)).toBeNull();
    expect(tools.handed).toEqual([]);
  });

  test("whose save fails changes nothing, and sends nothing", () => {
    const failing: Log = {
      append: () => ({ ok: false, reason: "disk full" }),
      carriedOut: () => ({ ok: true }),
    };
    const tools = recording();
    const loop = new Loop(config, tools, failing);

    const decision = loop.send(id, add(), 1_000);

    expect(decision).toEqual({
      ok: false,
      rejection: { input: "add", reason: "The events couldn't be saved: disk full" },
    });
    expect(loop.task(id)).toBeNull();
    expect(tools.handed).toEqual([]);
  });
});

describe("a command carried out", () => {
  test("is forgotten by the outbox once its tool says it has finished", () => {
    const store = EventStore.open(":memory:");
    let finish = () => {};
    const tools: Tools = { carryOut: (_command, finished) => (finish = finished) };
    const loop = new Loop(config, tools, store);
    loop.send(id, add(), 1_000);
    loop.send(id, start, 2_000);

    expect(store.loadCommands().ok && store.loadCommands()).toMatchObject({
      commands: [{ id: 1 }],
    });
    finish();
    expect(store.loadCommands()).toEqual({ ok: true, commands: [] });
  });
});

describe("starting what waits", () => {
  // Three tasks, added one after another.
  function threeQueued(tools: Tools) {
    const loop = new Loop(config, tools, EventStore.open(":memory:"));
    for (const n of [1, 2, 3]) loop.send(TaskId.parse(n), add(), n);
    return loop;
  }

  test("starts the oldest queued tasks, up to max_running", () => {
    const loop = threeQueued(recording());

    expect(loop.startWaiting(10)).toEqual([TaskId.parse(1), TaskId.parse(2)]);
    expect(loop.startWaiting(11)).toEqual([]);
  });

  test("keeps the slot of a start sent for a task that was killed, until its tool finishes", () => {
    const finishes: (() => void)[] = [];
    const tools: Tools = { carryOut: (_command, finished) => finishes.push(finished) };
    const loop = threeQueued(tools);
    loop.startWaiting(10);
    loop.send(TaskId.parse(1), kill, 11);

    expect(loop.inFlight).toBe(1);
    expect(loop.startWaiting(12)).toEqual([]);

    for (const finish of finishes) finish();
    expect(loop.inFlight).toBe(0);
    expect(loop.startWaiting(13)).toEqual([TaskId.parse(3)]);
  });
});
