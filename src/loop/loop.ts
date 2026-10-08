// The loop: what the daemon does with every input, and the simulator too, with
// fake tools.
//
// For each input it asks decide, saves the events and commands it returns in
// one transaction, applies the events with evolve, and hands the commands to
// the tools. The order matters: nothing changes and nothing goes out until the
// decision is saved, so a failed save changes nothing. The tools answer later,
// as new inputs.

import { decide } from "../core/decide";
import { evolve } from "../core/evolve";
import { schedule } from "../core/schedule";
import { waitingForSession } from "../core/task";
import type { Command, Config, Decision, Input, Task, TaskEvent, TaskId } from "../core/types";
import type { Loaded, Queued, Saved, SavedCommand } from "../store/store";

// Carries out the core's commands: making workspaces, starting and stopping
// sessions, merging.
//
// Once a command's work is done, its tool calls `reply` with the reply, or
// with null for a command that has none. The reply's events are saved in the
// same transaction as the command leaving the outbox, so the two never come
// apart. `reply` returns false when that save failed: the command stays in
// the outbox, and the tool calls `reply` again later.
//
// If the daemon dies before a command's reply is saved, it goes out again
// after the restart. So a tool may get a command twice, and doing it twice
// must have the effect of doing it once.
//
// A tool never replies from inside `carryOut`, only later, so one input is
// handled at a time.
export interface Tools {
  carryOut(command: Command, reply: Reply): void;
}

export type Reply = (input: Input | null) => boolean;

// Where decisions are saved. The event store is the real one.
export interface Log {
  // Saves a decision's events and commands, and drops the `done` commands
  // from the outbox, all in one transaction.
  append(events: TaskEvent[], commands: Command[], done?: number[]): Queued;
  carriedOut(id: number): Saved;
}

// A saved log that can be read back, to pick up where a loop left off.
export interface ReadableLog extends Log {
  loadTasks(): Loaded<{ tasks: Map<TaskId, Task> }>;
  loadCommands(): Loaded<{ commands: SavedCommand[] }>;
}

export class Loop {
  private readonly tasks: Map<TaskId, Task>;
  // Commands handed to the tools whose work hasn't finished, by their id in
  // the outbox.
  private readonly pending = new Map<number, Command>();
  // Set while an input is handled, so a tool replying from inside carryOut
  // is caught.
  private busy = false;
  private readonly now: () => number;

  constructor(
    private readonly config: Config,
    private readonly tools: Tools,
    private readonly log: Log,
    options: { tasks?: Map<TaskId, Task>; now?: () => number } = {},
  ) {
    this.tasks = options.tasks ?? new Map();
    this.now = options.now ?? Date.now;
  }

  // Picks up after a restart: every task rebuilt from the log, then every
  // command not yet carried out sent again, including one whose work was
  // still going on when the daemon died. The tools treat a repeat as doing
  // nothing new. Since those commands are pending again, the count of slots
  // in flight comes back too.
  static open(
    config: Config,
    tools: Tools,
    log: ReadableLog,
    now: () => number = Date.now,
  ): { ok: true; loop: Loop } | { ok: false; reason: string } {
    const tasks = log.loadTasks();
    if (!tasks.ok) return { ok: false, reason: `Event ${tasks.seq}: ${tasks.reason}` };
    const unfinished = log.loadCommands();
    if (!unfinished.ok) {
      return { ok: false, reason: `Command ${unfinished.seq}: ${unfinished.reason}` };
    }
    const loop = new Loop(config, tools, log, { tasks: tasks.tasks, now });
    loop.dispatch(unfinished.commands.map(({ id, command }) => ({ command, id })));
    return { ok: true, loop };
  }

  task(taskId: TaskId): Task | null {
    return this.tasks.get(taskId) ?? null;
  }

  // Every task the loop holds.
  all(): Task[] {
    return [...this.tasks.values()];
  }

  // Slots taken by work the tasks no longer record, for the scheduler: a
  // session or workspace still starting for a task that has moved on, such as
  // one killed while it started, and a late session's cleanup stop. Each
  // holds its slot until its tool finishes.
  get inFlight(): number {
    let count = 0;
    for (const command of this.pending.values()) if (untracked(command, this)) count++;
    return count;
  }

  // Delivers kept answers and starts the tasks the scheduler picks, within
  // max_running. Returns the tasks it picked.
  startWaiting(at: number): TaskId[] {
    const picks = this.picks();
    for (const { taskId, input } of picks) this.send(taskId, input, at);
    return picks.map(({ taskId }) => taskId);
  }

  // What the scheduler picks now, as the input each pick becomes: a kept
  // answer to deliver, or a start.
  picks(): { taskId: TaskId; input: Input }[] {
    return schedule(this.all(), this.config, this.inFlight).map((taskId) => {
      const kept = this.task(taskId)?.keptAnswer ?? null;
      const input: Input = { by: "daemon", type: kept === null ? "start" : "deliver_answer" };
      return { taskId, input };
    });
  }

  // One input for one task, at the given time.
  send(taskId: TaskId, input: Input, at: number): Decision {
    return this.handle(taskId, input, at, []).decision;
  }

  // Decides on one input, saves the decision with the commands it answers
  // leaving the outbox, applies it, then hands its commands to the tools.
  private handle(
    taskId: TaskId,
    input: Input,
    at: number,
    done: number[],
  ): { decision: Decision; saved: boolean } {
    if (this.busy) throw new Error("A tool replied from inside carryOut. Reply later instead.");
    const decision = decide(this.task(taskId), { taskId, at, input }, this.config);
    if (!decision.ok) return { decision, saved: true };

    const saved = this.log.append(decision.events, decision.commands, done);
    if (!saved.ok) {
      const reason = `The events couldn't be saved: ${saved.reason}`;
      return { decision: { ok: false, rejection: { input: input.type, reason } }, saved: false };
    }

    for (const event of decision.events) this.apply(event);
    this.dispatch(
      decision.commands.map((command, i) => {
        const id = saved.ids[i];
        if (id === undefined) throw new Error("The log saved a command without giving its id.");
        return { command, id };
      }),
    );
    return { decision, saved: true };
  }

  // Hands commands to the tools. Every one is counted as pending before the
  // first goes out, so the count of slots in flight is whole while they do.
  private dispatch(commands: { command: Command; id: number }[]): void {
    for (const { command, id } of commands) this.pending.set(id, command);
    this.busy = true;
    try {
      for (const { command, id } of commands) this.carryOut(command, id);
    } finally {
      this.busy = false;
    }
  }

  // Hands one command to the tools. It stays pending, and in the outbox,
  // until its tool says it has finished. Typing into a session is the
  // exception: it leaves the outbox before it is typed, so a crash in between
  // loses the message rather than typing it twice.
  private carryOut(command: Command, id: number): void {
    if (command.type === "type_into_session") {
      this.pending.delete(id);
      // If it can't leave the outbox, it isn't typed: a restart would type
      // it again. The message is lost instead, as the spec allows.
      if (!this.log.carriedOut(id).ok) return;
      this.tools.carryOut(command, () => true);
      return;
    }
    this.tools.carryOut(command, (input) => {
      if (!this.pending.has(id)) return true; // answered already
      const answered = this.answer(command, input, id);
      if (answered) this.pending.delete(id);
      return answered;
    });
  }

  // A tool's reply to a command: saved with the command leaving the outbox,
  // or for a reply the core refuses, the command just leaves. False when a
  // save failed, so the tool replies again later.
  private answer(command: Command, input: Input | null, id: number): boolean {
    if (input === null || !("taskId" in command)) return this.log.carriedOut(id).ok;
    const handled = this.handle(command.taskId, input, this.now(), [id]);
    if (!handled.saved) return false;
    if (!handled.decision.ok) return this.log.carriedOut(id).ok;
    return true;
  }

  // decide never produces an event evolve refuses. If it ever does, that is a
  // bug in the core, and carrying on would build a wrong task.
  private apply(event: TaskEvent): void {
    const evolved = evolve(this.task(event.taskId), event);
    if (!evolved.ok) throw new Error(`evolve refused decide's event: ${evolved.reason}`);
    this.tasks.set(event.taskId, evolved.task);
  }
}

// Whether a command still under way holds a slot its task no longer records.
// A start the task still waits for, and a stop it records as stopping, are
// counted from the task by the scheduler already.
function untracked(command: Command, loop: Loop): boolean {
  switch (command.type) {
    case "start_session":
    case "create_workspace":
    case "create_copy": {
      const task = loop.task(command.taskId);
      if (task === null || task.phase === "ended") return true;
      if (command.type === "start_session") return !waitingForSession(task, command.request);
      return !("request" in task.step && task.step.request === command.request);
    }
    case "stop_session": {
      const task = loop.task(command.taskId);
      return command.request === null || task?.stopping?.request !== command.request;
    }
    default:
      return false;
  }
}
