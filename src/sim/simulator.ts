// The simulator: the real loop and store, with fake tools and scripted agents
// in place of git, tmux and Claude Code. Whole lifecycles, with several tasks
// sharing max_running and a restart halfway, run in tests in milliseconds.
//
// Each command goes to a fake tool, which queues the reply the real one would
// send. Each agent that starts queues what its role does next: the planner
// proceeds, the builder hands over, the tester passes or asks for changes.
// Each task's behaviour says what goes wrong for it.
//
// With a seed, replies from different tasks are interleaved at random, and
// saves can fail at random too. Within one task, the order stays as it would
// be. Every input whose save fails is checked to have changed nothing, and is
// sent again, as the daemon does.
//
// It is test machinery, not rules, so it lives outside the core.

import { CommitSha, SessionId } from "../core/ids";
import type { Command, Config, Delivered, Input, Intent, TaskEvent, TaskId } from "../core/types";
import { Loop, type ReadableLog, type Reply, type Tools } from "../loop/loop";
import { EventStore } from "../store/store";

// What goes wrong for one task. Anything left out goes well.
export type Behaviour = {
  intent?: Intent;
  changes?: number; // how many times the tester asks for changes
  conflicts?: number; // how many times merging main conflicts
};

// Something waiting to reach the loop: a tool's reply to a command, handed
// to the loop's reply function, or an agent's next report, sent as an input.
type Job =
  // A command with no task, such as removing a workspace, has a null task.
  // A stop's reply ends its agent's life when it is handled, not before, so
  // a stop in flight still counts against max_running.
  | {
      kind: "reply";
      taskId: TaskId | null;
      input: Input | null;
      reply: Reply;
      stops: SessionId | null;
    }
  // Anything else sent as an input: an agent's report, or a start the
  // scheduler picked.
  | { kind: "input"; taskId: TaskId; input: Input };

export type Options = {
  seed?: number; // interleaves tasks' replies at random
  failSaves?: number; // the chance that a save fails, from 0 to 1
};

export class Simulator {
  // The most agents ever live at once, from their start to their stop.
  mostAgentsAtOnce = 0;

  private readonly store = EventStore.open(":memory:");
  private readonly log: ReadableLog;
  private readonly random: (() => number) | null;
  private failSaves: number;
  private saveFailed = false;
  private handed = 0;
  private loop: Loop;
  private queue: Job[] = [];
  private readonly behaviours = new Map<TaskId, Required<Behaviour>>();
  private readonly live = new Set<SessionId>();
  private readonly started = new Set<string>(); // "task:request" of each session started
  // Each command's reply, so a command sent again after a restart gets the
  // same answer, as a real tool must give.
  private readonly answers = new Map<string, { taskId: TaskId; input: Input } | null>();
  private now = 1_000;
  private commits = 0;

  constructor(
    private readonly config: Config,
    options: Options = {},
  ) {
    this.random = options.seed === undefined ? null : mulberry32(options.seed);
    this.failSaves = options.failSaves ?? 0;
    this.log = this.flaky();
    this.loop = new Loop(config, this.tools(), this.log, { now: () => this.tick() });
  }

  // No more failed saves, so a run can finish.
  calm(): void {
    this.failSaves = 0;
  }

  // Whether the loop's tasks match a fresh replay of the saved log.
  // Both ways: the loop holds no task the log doesn't.
  tasksMatchTheLog(): boolean {
    const loaded = this.store.loadTasks();
    if (!loaded.ok || loaded.tasks.size !== this.loop.all().length) return false;
    for (const [taskId, task] of loaded.tasks) {
      if (!Bun.deepEquals(this.loop.task(taskId), task)) return false;
    }
    return true;
  }

  // Adds a task. With an intent, it skips triage. Without one, the planner
  // decides `ship`, or the behaviour's intent.
  add(taskId: TaskId, behaviour: Behaviour = {}): void {
    this.behaviours.set(taskId, {
      intent: behaviour.intent ?? "ship",
      changes: behaviour.changes ?? 0,
      conflicts: behaviour.conflicts ?? 0,
    });
    const input: Input = {
      by: "you",
      type: "add",
      title: `Task ${taskId}`,
      description: null,
      plan:
        behaviour.intent === undefined
          ? null
          : { intent: behaviour.intent, rigor: "light", approve: false },
    };
    while (!this.send(taskId, input)) {}
  }

  // Runs until nothing is left to do, or for at most `steps` steps. When
  // nothing waits, the loop starts what the scheduler picks.
  run(limit: { steps?: number } = {}): void {
    for (let step = 0; step < (limit.steps ?? 10_000); step++) {
      // Nothing waits: start what the scheduler picks, each through the same
      // checks as any other input. Stop when it picks nothing.
      if (this.queue.length === 0) {
        const picks = this.loop.picks();
        if (picks.length === 0) return;
        for (const { taskId, input } of picks) this.queue.push({ kind: "input", taskId, input });
      }
      const job = this.next();
      if (job === undefined) continue;
      if (!this.deliver(job)) this.queue.unshift(job); // sent again, as the daemon does
    }
  }

  // The next job: the oldest, or with a seed, the oldest of a task picked at
  // random, so each task's own order is kept.
  private next(): Job | undefined {
    if (this.random === null) return this.queue.shift();
    const firsts = [...new Set(this.queue.map((job) => job.taskId))];
    const taskId = firsts[Math.floor(this.random() * firsts.length)];
    const i = this.queue.findIndex((job) => job.taskId === taskId);
    return i < 0 ? undefined : this.queue.splice(i, 1)[0];
  }

  // Hands a job to the loop. False if its save failed, after checking it
  // changed nothing and sent nothing (rule 17).
  private deliver(job: Job): boolean {
    const before = job.taskId === null ? null : this.loop.task(job.taskId);
    const handed = this.handed;
    this.saveFailed = false;
    // A stopped agent is gone once its stop's reply is handled, which may
    // start the task's next agent in the same decision. So it leaves first,
    // and comes back if the save fails.
    const stops = job.kind === "reply" ? job.stops : null;
    if (stops !== null) this.live.delete(stops);
    if (job.kind === "reply") job.reply(job.input);
    else this.loop.send(job.taskId, job.input);
    if (!this.saveFailed) return true;
    if (stops !== null) this.live.add(stops);
    const after = job.taskId === null ? null : this.loop.task(job.taskId);
    if (!Bun.deepEquals(after, before) || this.handed !== handed) {
      throw new Error(`A failed save changed #${job.taskId}, or sent a command.`);
    }
    return false;
  }

  // Sends one input of yours. False if its save failed.
  private send(taskId: TaskId, input: Input): boolean {
    return this.deliver({ kind: "input", taskId, input });
  }

  // The store, with saves that fail at random.
  private flaky(): ReadableLog {
    const store = this.store;
    return {
      append: (events: TaskEvent[], commands: Command[], answered?: number[]) => {
        if (this.random !== null && this.random() < this.failSaves) {
          this.saveFailed = true;
          return { ok: false, reason: "a simulated failure" };
        }
        return store.append(events, commands, answered);
      },
      carriedOut: (id: number) => store.carriedOut(id),
      loadTasks: () => store.loadTasks(),
      loadCommands: () => store.loadCommands(),
    };
  }

  // The daemon restarts. Work the tools hadn't finished is lost, and the
  // reopened loop sends it again from the outbox. Agents keep running, as
  // they do in tmux, so their next reports still arrive. A start picked
  // before the restart is kept too, and refused if it no longer fits.
  restart(): void {
    const agents = this.queue.filter((job) => job.kind === "input");
    this.queue = [];
    const opened = Loop.open(this.config, this.tools(), this.log, { now: () => this.tick() });
    if (!opened.ok) throw new Error(opened.reason);
    this.loop = opened.loop;
    // Replies sent again go first, so an agent's report still comes after
    // its session's start.
    this.queue.push(...agents);
  }

  // How the task ended, or null while it hasn't.
  outcome(taskId: TaskId): string | null {
    const task = this.loop.task(taskId);
    return task?.phase === "ended" ? task.outcome.kind : null;
  }

  // The type of every event saved for the task, oldest first.
  events(taskId: TaskId): string[] {
    const loaded = this.store.loadTaskEvents(taskId);
    return loaded.ok ? loaded.events.map((event) => event.type) : [];
  }

  delivered(taskId: TaskId): Delivered | null {
    const task = this.loop.task(taskId);
    if (task?.phase !== "ended" || task.outcome.kind !== "done") return null;
    return task.outcome.delivered;
  }

  // ---------------------------------------------------------------------------
  // The fake tools
  // ---------------------------------------------------------------------------

  private tools(): Tools {
    return { carryOut: (command, reply) => this.carryOut(command, reply) };
  }

  // Queues the command's reply, handed to the loop later, never from in
  // here. The reply goes first, so a new agent's report arrives after its
  // start.
  private carryOut(command: Command, reply: Reply): void {
    this.handed++;
    const key =
      "request" in command ? `${command.type}:${command.taskId}:${command.request}` : null;
    const answer =
      key !== null && this.answers.has(key) ? this.answers.get(key) : this.replyTo(command);
    if (key !== null) this.answers.set(key, answer ?? null);
    const taskId = "taskId" in command ? command.taskId : null;
    const stops = command.type === "stop_session" ? command.session : null;
    this.queue.push({ kind: "reply", taskId, input: answer?.input ?? null, reply, stops });
    if (command.type === "start_session") this.startAgent(command);
  }

  // What the real tool would send back for a command, or null for one with
  // no reply.
  private replyTo(command: Command): { taskId: TaskId; input: Input } | null {
    switch (command.type) {
      case "create_workspace":
        return {
          taskId: command.taskId,
          input: {
            by: "plugin",
            type: "workspace_created",
            request: command.request,
            workspace: { path: `/sim/${command.taskId}`, branch: `skel/${command.taskId}` },
          },
        };

      case "create_copy":
        return {
          taskId: command.taskId,
          input: {
            by: "plugin",
            type: "copy_created",
            request: command.request,
            copy: {
              path: `/sim/${command.taskId}-copy-${command.request}`,
              commit: command.commit,
            },
          },
        };

      case "start_session":
        return {
          taskId: command.taskId,
          input: {
            by: "plugin",
            type: "session_started",
            request: command.request,
            session: sessionOf(command),
          },
        };

      // A late session's cleanup stop has no reply.
      case "stop_session":
        if (command.request === null) return null;
        return {
          taskId: command.taskId,
          input: {
            by: "plugin",
            type: "stopped",
            request: command.request,
            session: command.session,
            saved: command.save ? "saved" : "nothing_to_save",
            message: "",
          },
        };

      case "commit_spec":
        return {
          taskId: command.taskId,
          input: {
            by: "plugin",
            type: "spec_committed",
            request: command.request,
            path: `docs/plans/${command.taskId}.md`,
          },
        };

      case "merge_main": {
        const behaviour = this.behaviour(command.taskId);
        if (behaviour.conflicts > 0) {
          behaviour.conflicts--;
          return {
            taskId: command.taskId,
            input: {
              by: "plugin",
              type: "main_conflict",
              request: command.request,
              files: ["src/x.ts"],
            },
          };
        }
        return {
          taskId: command.taskId,
          input: {
            by: "plugin",
            type: "main_merged",
            request: command.request,
            reviewed: { head: this.commit(), changedFiles: ["src/x.ts"] },
          },
        };
      }

      case "deliver": {
        const commit = command.reviewed.head;
        return {
          taskId: command.taskId,
          input: {
            by: "plugin",
            type: "delivered",
            request: command.request,
            delivered:
              command.intent === "answer"
                ? { kind: "report", path: `docs/answers/${command.taskId}.md`, commit }
                : { kind: "branch", commit, ref: `skel/${command.taskId}` },
          },
        };
      }

      case "remove_workspace":
      case "type_into_session":
        return null;
    }
  }

  // Starts the agent for a session, unless it already started: a start sent
  // again after a restart starts no second agent.
  private startAgent(command: Extract<Command, { type: "start_session" }>): void {
    const key = `${command.taskId}:${command.request}`;
    if (this.started.has(key)) return;
    this.started.add(key);
    const session = sessionOf(command);
    this.live.add(session);
    this.mostAgentsAtOnce = Math.max(this.mostAgentsAtOnce, this.live.size);
    const next = this.agent(command.taskId, command.role, session);
    this.queue.push({ kind: "input", taskId: command.taskId, input: next });
  }

  // ---------------------------------------------------------------------------
  // The scripted agents
  // ---------------------------------------------------------------------------

  // What an agent of this role reports once it has done its work.
  private agent(taskId: TaskId, role: "planner" | "builder" | "tester", session: SessionId): Input {
    const behaviour = this.behaviour(taskId);
    switch (role) {
      case "planner":
        return {
          by: "agent",
          session,
          type: "triage_proceed",
          plan: { intent: behaviour.intent, rigor: "light", approve: false, brief: "Do it." },
          spec: null,
        };
      case "builder": {
        const branch = { head: this.commit(), changedFiles: ["src/x.ts"] };
        if (behaviour.intent === "answer") {
          return {
            by: "agent",
            session,
            type: "done_answer",
            report: "Here's why.",
            proposals: [],
            branch,
          };
        }
        return { by: "agent", session, type: "done", summary: "Done.", branch };
      }
      case "tester":
        if (behaviour.changes > 0) {
          behaviour.changes--;
          return { by: "agent", session, type: "changes", findings: "Not yet." };
        }
        return { by: "agent", session, type: "pass", evidence: "Tests pass." };
    }
  }

  private behaviour(taskId: TaskId): Required<Behaviour> {
    const behaviour = this.behaviours.get(taskId);
    if (behaviour === undefined) throw new Error(`The simulator doesn't know #${taskId}.`);
    return behaviour;
  }

  private commit(): CommitSha {
    this.commits++;
    return CommitSha.parse(this.commits.toString(16).padStart(40, "0"));
  }

  private tick(): number {
    this.now += 1_000;
    return this.now;
  }
}

function sessionOf(command: Extract<Command, { type: "start_session" }>): SessionId {
  return SessionId.parse(`s-${command.taskId}-${command.request}`);
}

// A small seeded random source, so a failing run can be replayed.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
