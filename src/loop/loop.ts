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
// Once a command's work is done, its tool calls `reply` once, with the reply,
// or with null for a command that has none. The reply's events are saved in
// the same transaction as the command leaving the outbox, so the two never
// come apart. If that save fails, the loop keeps the reply and tries again
// on retryReplies, so a tool never has to.
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

export type Reply = (input: Input | null) => void;

// Where decisions are saved. The event store is the real one.
export interface Log {
  // Saves a decision's events and commands, and drops the commands it
  // answers from the outbox, all in one transaction.
  append(events: TaskEvent[], commands: Command[], answered?: number[]): Queued;
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
  // Replies whose save failed, by their command's outbox id, to try again.
  private readonly unsaved = new Map<number, Input | null>();
  // Set by dispatch while it hands commands to the tools. handle refuses any
  // input while it is set, which catches a tool replying from inside carryOut.
  private busy = false;
  // The one clock: every input is stamped with its time, whoever sent it.
  // The real clock in the daemon, a fake one in tests.
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
    options: { now?: () => number } = {},
  ): { ok: true; loop: Loop } | { ok: false; reason: string } {
    const tasks = log.loadTasks();
    if (!tasks.ok) return { ok: false, reason: `Event ${tasks.row}: ${tasks.reason}` };
    const unfinished = log.loadCommands();
    if (!unfinished.ok) {
      return { ok: false, reason: `Command ${unfinished.row}: ${unfinished.reason}` };
    }
    const loop = new Loop(config, tools, log, { ...options, tasks: tasks.tasks });
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
    for (const command of this.pending.values()) if (this.untracked(command)) count++;
    return count;
  }

  // Delivers kept answers and starts the tasks the scheduler picks, within
  // max_running. Returns the tasks it picked.
  startWaiting(): TaskId[] {
    const picks = this.picks();
    for (const { taskId, input } of picks) this.send(taskId, input);
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

  // Tries again to save every reply whose save failed. The daemon calls it on
  // its tick. A reply that fails again is kept for the next try, with no
  // limit: v3 gave up after five, and a task then held its slot until a
  // restart, even once the disk was fine.
  retryReplies(): void {
    for (const [id, input] of [...this.unsaved]) {
      const command = this.pending.get(id);
      this.unsaved.delete(id);
      if (command !== undefined) this.receive(command, input, id);
    }
  }

  // One input for one task, at the time on the loop's clock.
  send(taskId: TaskId, input: Input): Decision {
    return this.handle(taskId, input, []).decision;
  }

  // Decides on one input, saves the decision with the commands it answers
  // leaving the outbox, applies it, then hands its commands to the tools.
  private handle(
    taskId: TaskId,
    input: Input,
    answered: number[],
  ): { decision: Decision; saveFailed: boolean } {
    if (this.busy) throw new Error("A tool replied from inside carryOut. Reply later instead.");
    const decision = decide(this.task(taskId), { taskId, at: this.now(), input }, this.config);
    if (!decision.ok) return { decision, saveFailed: false };

    const saved = this.log.append(decision.events, decision.commands, answered);
    if (!saved.ok) {
      const reason = `The events couldn't be saved: ${saved.reason}`;
      return {
        decision: { ok: false, rejection: { input: input.type, reason } },
        saveFailed: true,
      };
    }

    for (const event of decision.events) this.apply(event);
    this.dispatch(
      decision.commands.map((command, i) => {
        const id = saved.ids[i];
        if (id === undefined) throw new Error("The log saved a command without giving its id.");
        return { command, id };
      }),
    );
    return { decision, saveFailed: false };
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
      this.tools.carryOut(command, () => {});
      return;
    }
    this.tools.carryOut(command, (input) => {
      if (this.pending.has(id) && !this.unsaved.has(id)) this.receive(command, input, id);
    });
  }

  // Saves a reply, or keeps it to try again if the save fails.
  private receive(command: Command, input: Input | null, id: number): void {
    if (this.answer(command, input, id)) this.pending.delete(id);
    else this.unsaved.set(id, input);
  }

  // A tool's reply to a command: saved with the command leaving the outbox,
  // or for a reply the core refuses, the command just leaves. False when a
  // save failed.
  private answer(command: Command, input: Input | null, id: number): boolean {
    if (input === null || !("taskId" in command)) return this.log.carriedOut(id).ok;
    const handled = this.handle(command.taskId, input, [id]);
    if (handled.saveFailed) return false;
    if (!handled.decision.ok) return this.log.carriedOut(id).ok;
    return true;
  }

  // decide never produces an event evolve refuses. If it ever does, that is a
  // bug in the core, and carrying on would build a wrong task. The event is
  // already saved, so a restart refuses the same log and won't open either.
  private apply(event: TaskEvent): void {
    const evolved = evolve(this.task(event.taskId), event);
    if (!evolved.ok) throw new Error(`evolve refused decide's event: ${evolved.reason}`);
    this.tasks.set(event.taskId, evolved.task);
  }

  // Whether a command still under way holds a slot its task no longer
  // records. A start the task still waits for, and a stop it records as
  // stopping, are counted from the task by the scheduler already.
  private untracked(command: Command): boolean {
    switch (command.type) {
      case "start_session":
      case "create_workspace":
      case "create_copy": {
        const task = this.task(command.taskId);
        if (task === null || task.phase === "ended") return true;
        if (command.type === "start_session") return !waitingForSession(task, command.request);
        return !("request" in task.step && task.step.request === command.request);
      }
      case "stop_session": {
        const task = this.task(command.taskId);
        return command.request === null || task?.stopping?.request !== command.request;
      }
      default:
        return false;
    }
  }
}
