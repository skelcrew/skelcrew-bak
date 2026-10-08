// The event store: every event, in the order it happened, in one SQLite
// file. The log is what is saved. Tasks are rebuilt from it by replaying
// their events through evolve. Beside it, the outbox keeps each command until
// it is carried out, so a crash in between loses nothing.
//
// Each event is checked twice: against its schema before it is written, so
// nothing malformed gets in, and again when read back, since anything could
// have happened to the file in between.

import { Database } from "bun:sqlite";
import { evolve } from "../core/evolve";
import type { Command, Task, TaskEvent, TaskId } from "../core/types";
import { parseCommand, parseTaskEvent } from "./schema";

// Each change to the table layout is one step, run once, in order. The
// file's user_version says how many have run.
const migrations = [
  `CREATE TABLE events (
     seq     INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id INTEGER NOT NULL,
     body    TEXT NOT NULL
   );
   CREATE INDEX events_by_task ON events (task_id, seq);`,
  // Commands saved with their decision and not yet carried out. If the
  // daemon dies before one finishes, it goes out again after the restart.
  `CREATE TABLE commands (
     id   INTEGER PRIMARY KEY AUTOINCREMENT,
     body TEXT NOT NULL
   );`,
];

export type Saved = { ok: true } | { ok: false; reason: string };

// A saved decision, with the id of each of its commands, in order. There is
// always one id per command.
export type Queued = { ok: true; ids: number[] } | { ok: false; reason: string };

export type SavedCommand = { id: number; command: Command };

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

  // Saves one decision's events and commands together, and drops the
  // commands it answers from the outbox: all of it, or none if anything fails
  // its schema. Returns each new command's id, to mark it carried out later.
  append(events: TaskEvent[], commands: Command[] = [], answered: number[] = []): Queued {
    for (const event of events) {
      const parsed = parseTaskEvent(readJson(JSON.stringify(event)));
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
    }
    for (const command of commands) {
      const parsed = parseCommand(readJson(JSON.stringify(command)));
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
    }
    // SQLite can refuse a write, such as on a full disk. The transaction
    // then saves nothing, and the failure comes back as a value.
    return attempt(() => {
      const insert = this.db.query("INSERT INTO events (task_id, body) VALUES ($task, $body)");
      const queue = this.db.query<{ id: number }, { body: string }>(
        "INSERT INTO commands (body) VALUES ($body) RETURNING id",
      );
      const remove = this.db.query("DELETE FROM commands WHERE id = $id");
      const ids = this.db.transaction(() => {
        for (const event of events) {
          insert.run({ task: event.taskId, body: JSON.stringify(event) });
        }
        for (const id of answered) remove.run({ id });
        return commands.map((command) => {
          const row = queue.get({ body: JSON.stringify(command) });
          if (row === null) throw new Error("SQLite returned no id for a saved command.");
          return row.id;
        });
      })();
      return { ok: true, ids };
    });
  }

  // A command has been carried out, so a restart won't send it again.
  carriedOut(id: number): Saved {
    return attempt(() => {
      this.db.query("DELETE FROM commands WHERE id = $id").run({ id });
      return { ok: true };
    });
  }

  // The commands saved and not yet carried out, oldest first. A damaged one
  // is reported with its id.
  loadCommands(): Loaded<{ commands: SavedCommand[] }> {
    const rows = this.db
      .query<{ id: number; body: string }, []>("SELECT id, body FROM commands ORDER BY id")
      .all();
    const commands: SavedCommand[] = [];
    for (const row of rows) {
      const parsed = parseCommand(readJson(row.body));
      if (!parsed.ok) return { ok: false, seq: row.id, reason: parsed.reason };
      commands.push({ id: row.id, command: parsed.value });
    }
    return { ok: true, commands };
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

// Runs a write, turning an error SQLite throws into a failure value.
function attempt<T extends { ok: true }>(write: () => T): T | { ok: false; reason: string } {
  try {
    return write();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
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
