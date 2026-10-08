import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskId } from "../core/ids";
import {
  add,
  builder,
  done,
  id,
  planner,
  play,
  proceed,
  sessionStarted,
  start,
  stopped,
  workspaceCreated,
} from "../core/testing";
import type { Command, Task, TaskEvent } from "../core/types";
import { EventStore } from "./store";

// Every event of one task that went through triage, and whose builder has
// handed over, in order.
function lifecycle(): { events: TaskEvent[]; task: Task } {
  const inputs = [
    add(),
    start,
    workspaceCreated(1),
    sessionStarted(2, planner),
    proceed(),
    stopped(3, planner),
    sessionStarted(4, builder),
    done(),
  ];
  const all: TaskEvent[] = [];
  let task: Task | null = null;
  for (const input of inputs) {
    const step = play(task, [input]);
    all.push(...step.events);
    task = step.task;
  }
  if (task === null) throw new Error("no task");
  return { events: all, task };
}

const events = () => lifecycle().events;

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function file(): string {
  const dir = mkdtempSync(join(tmpdir(), "skelcrew-store-"));
  dirs.push(dir);
  return join(dir, "skelcrew.db");
}

describe("the event store", () => {
  test("rebuilds every task from its events", () => {
    const store = EventStore.open(":memory:");
    const { events: log, task } = lifecycle();
    expect(store.append(log)).toEqual({ ok: true, ids: [] });

    expect(store.loadTasks()).toEqual({ ok: true, tasks: new Map([[id, task]]) });
  });

  test("keeps what it saved across reopening the file", () => {
    const path = file();
    const first = EventStore.open(path);
    first.append(events());
    first.close();

    const loaded = EventStore.open(path).loadTasks();
    expect(loaded.ok && loaded.tasks.get(id)?.phase).toBe("build");
  });

  test("reads one task's events back, oldest first", () => {
    const store = EventStore.open(":memory:");
    const log = events();
    store.append(log);

    expect(store.loadTaskEvents(id)).toEqual({ ok: true, events: log });
    expect(store.loadTaskEvents(TaskId.parse(7))).toEqual({ ok: true, events: [] });
  });

  test("saves nothing when one event doesn't fit its schema", () => {
    const store = EventStore.open(":memory:");
    const [good] = events();
    if (good === undefined) throw new Error("no events");
    const bad = { ...good, surprise: true };

    const saved = store.append([good, bad]);
    expect(saved.ok).toBe(false);
    expect(store.loadTasks()).toEqual({ ok: true, tasks: new Map() });
  });

  test("reports a damaged row with its position, instead of guessing", () => {
    const path = file();
    const store = EventStore.open(path);
    store.append(events());
    store.close();
    const db = new Database(path);
    db.run("UPDATE events SET body = 'not json' WHERE seq = 3");
    db.close();

    const loaded = EventStore.open(path).loadTasks();
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.seq).toBe(3);
  });

  test("reports an event that doesn't fit the task, which a damaged log could hold", () => {
    const path = file();
    const store = EventStore.open(path);
    const log = events();
    store.append(log);
    store.close();
    const db = new Database(path);
    db.run("DELETE FROM events WHERE seq = 1");
    db.close();

    const loaded = EventStore.open(path).loadTasks();
    expect(!loaded.ok && loaded.seq).toBe(2);
  });
});

const stop: Command = {
  type: "stop_session",
  taskId: id,
  request: 9,
  session: builder,
  save: true,
  remove: null,
};

describe("the outbox", () => {
  test("saves commands with their events, and hands back their ids", () => {
    const store = EventStore.open(":memory:");

    expect(store.append(events(), [stop])).toEqual({ ok: true, ids: [1] });
    expect(store.loadCommands()).toEqual({ ok: true, commands: [{ id: 1, command: stop }] });
  });

  test("forgets a command once it is carried out", () => {
    const store = EventStore.open(":memory:");
    store.append(events(), [stop]);
    store.carriedOut(1);

    expect(store.loadCommands()).toEqual({ ok: true, commands: [] });
  });

  test("saves nothing, events included, when a command doesn't fit its schema", () => {
    const store = EventStore.open(":memory:");
    // A command the core could never produce, as a damaged caller might send.
    const bad = JSON.parse(JSON.stringify({ ...stop, extra: 1 }));

    expect(store.append(events(), [bad]).ok).toBe(false);
    expect(store.loadTasks()).toEqual({ ok: true, tasks: new Map() });
    expect(store.loadCommands()).toEqual({ ok: true, commands: [] });
  });

  test("reports a damaged command with its id", () => {
    const path = file();
    const store = EventStore.open(path);
    store.append(events(), [stop]);
    store.close();
    const db = new Database(path);
    db.run("UPDATE commands SET body = '{}' WHERE id = 1");
    db.close();

    const loaded = EventStore.open(path).loadCommands();
    expect(!loaded.ok && loaded.seq).toBe(1);
  });
});

describe("a write SQLite refuses", () => {
  test("comes back as a failure, not an exception", () => {
    const store = EventStore.open(":memory:");
    store.close();

    expect(store.append(events(), []).ok).toBe(false);
    expect(store.carriedOut(1).ok).toBe(false);
  });
});
