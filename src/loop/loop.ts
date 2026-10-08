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
import type { Queued, Saved } from "../store/store";

// Carries out the core's commands: making workspaces, starting and stopping
// sessions, merging. Replies come back later through Loop.send.
//
// A tool calls `finished` once the command's work is done. For a command that
// expects a reply, that is once the reply has been sent to the loop. Until
// then the command stays in the outbox, so if the daemon dies first, it goes
// out again after the restart. So a tool may get a command twice, and doing
// it twice must have the effect of doing it once.
export interface Tools {
  carryOut(command: Command, finished: () => void): void;
}

// Where decisions are saved. The event store is the real one.
export interface Log {
  append(events: TaskEvent[], commands: Command[]): Queued;
  carriedOut(id: number): Saved;
}

export class Loop {
  private readonly tasks = new Map<TaskId, Task>();
  // Commands handed to the tools whose work hasn't finished, by a key of our
  // own, since a command without a log has no id.
  private readonly pending = new Map<number, Command>();
  private nextKey = 1;

  constructor(
    private readonly config: Config,
    private readonly tools: Tools,
    private readonly log: Log,
  ) {}

  task(taskId: TaskId): Task | null {
    return this.tasks.get(taskId) ?? null;
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
    const picks = schedule([...this.tasks.values()], this.config, this.inFlight);
    for (const taskId of picks) {
      const kept = this.task(taskId)?.keptAnswer ?? null;
      this.send(taskId, { by: "daemon", type: kept === null ? "start" : "deliver_answer" }, at);
    }
    return picks;
  }

  // One input for one task, at the given time.
  send(taskId: TaskId, input: Input, at: number): Decision {
    const before = this.task(taskId);
    const decision = decide(before, { taskId, at, input }, this.config);
    if (!decision.ok) return decision;

    const saved = this.log.append(decision.events, decision.commands);
    if (!saved.ok) {
      const reason = `The events couldn't be saved: ${saved.reason}`;
      return { ok: false, rejection: { input: input.type, reason } };
    }

    for (const event of decision.events) this.apply(event);
    for (const [i, command] of decision.commands.entries()) {
      const id = saved.ids[i];
      const key = this.nextKey++;
      this.pending.set(key, command);
      this.tools.carryOut(command, () => {
        this.pending.delete(key);
        if (id !== undefined) this.log.carriedOut(id);
      });
    }
    return decision;
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
