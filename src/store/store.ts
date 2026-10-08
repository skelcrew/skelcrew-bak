// The event store: every event, in the order it happened, in one SQLite
// file. The log is what is saved. Tasks are rebuilt from it by replaying
// their events through evolve.
//
// Each event is checked twice: against its schema before it is written, so
// nothing malformed gets in, and again when read back, since anything could
// have happened to the file in between.

import { Database } from "bun:sqlite";
import { evolve } from "../core/evolve";
import type { Task, TaskEvent, TaskId } from "../core/types";
import { parseTaskEvent } from "./schema";

// Each change to the table layout is one step, run once, in order. The
// file's user_version says how many have run.
const migrations = [
  `CREATE TABLE events (
     seq     INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id INTEGER NOT NULL,
     body    TEXT NOT NULL
   );
   CREATE INDEX events_by_task ON events (task_id, seq);`,
];

export type Saved = { ok: true } | { ok: false; reason: string };

// What was read back, or the position of the first row that couldn't be
// read or didn't fit, so it can be found and looked at.
export type Loaded<T> = ({ ok: true } & T) | { ok: false; seq: number; reason: string };

export class EventStore {
  private constructor(private readonly db: Database) {}

  // Opens the file, creating it and its tables when it's new. ":memory:"
  // gives a store that lives only as long as the process, for tests.
  static open(path: string): EventStore {
    const db = new Database(path, { create: true, strict: true });
    // Wait for another connection's write instead of failing at once. v3
    // found bun:sqlite's default wait of zero gave "database is locked".
    db.run("PRAGMA busy_timeout = 10000");
    db.run("PRAGMA journal_mode = WAL");
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    const done = version?.user_version ?? 0;
    for (const [i, step] of migrations.entries()) {
      if (i < done) continue;
      db.transaction(() => {
        db.run(step);
        db.run(`PRAGMA user_version = ${i + 1}`);
      })();
    }
    return new EventStore(db);
  }

  close(): void {
    this.db.close();
  }

  // Saves one decision's events together: all of them, or none if any fails
  // its schema.
  append(events: TaskEvent[]): Saved {
    for (const event of events) {
      const parsed = parseTaskEvent(readJson(JSON.stringify(event)));
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
    }
    const insert = this.db.query("INSERT INTO events (task_id, body) VALUES ($task, $body)");
    this.db.transaction(() => {
      for (const event of events) insert.run({ task: event.taskId, body: JSON.stringify(event) });
    })();
    return { ok: true };
  }

  // Every task, rebuilt from the log. A row that can't be read, or an event
  // that doesn't fit its task, stops it there, with the row's position.
  loadTasks(): Loaded<{ tasks: Map<TaskId, Task> }> {
    const rows = this.db
      .query<{ seq: number; body: string }, []>("SELECT seq, body FROM events ORDER BY seq")
      .all();
    const tasks = new Map<TaskId, Task>();
    for (const row of rows) {
      const parsed = parseTaskEvent(readJson(row.body));
      if (!parsed.ok) return { ok: false, seq: row.seq, reason: parsed.reason };
      const event = parsed.value;
      const evolved = evolve(tasks.get(event.taskId) ?? null, event);
      if (!evolved.ok) return { ok: false, seq: row.seq, reason: evolved.reason };
      tasks.set(event.taskId, evolved.task);
    }
    return { ok: true, tasks };
  }

  // One task's events, oldest first, for its log. None for a task that
  // doesn't exist.
  loadTaskEvents(taskId: TaskId): Loaded<{ events: TaskEvent[] }> {
    const rows = this.db
      .query<{ seq: number; body: string }, { task: number }>(
        "SELECT seq, body FROM events WHERE task_id = $task ORDER BY seq",
      )
      .all({ task: taskId });
    const events: TaskEvent[] = [];
    for (const row of rows) {
      const parsed = parseTaskEvent(readJson(row.body));
      if (!parsed.ok) return { ok: false, seq: row.seq, reason: parsed.reason };
      events.push(parsed.value);
    }
    return { ok: true, events };
  }
}

// A row that isn't JSON at all is read as a value no schema accepts, so it is
// reported like any other damaged event.
function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
