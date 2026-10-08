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

  constructor(
    private readonly config: Config,
    private readonly tools: Tools,
    private readonly log: Log,
  ) {}

  task(taskId: TaskId): Task | null {
    return this.tasks.get(taskId) ?? null;
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
      this.tools.carryOut(command, () => {
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
