// The simulator: the real loop and store, with fake tools and scripted agents
// in place of git, tmux and Claude Code. Whole lifecycles, with several tasks
// sharing max_running and a restart halfway, run in tests in milliseconds.
//
// Each command goes to a fake tool, which queues the reply the real one would
// send. Each agent that starts queues what its role does next: the planner
// proceeds, the builder hands over, the tester passes or asks for changes.
// Each task's behaviour says what goes wrong for it.
//
// It is test machinery, not rules, so it lives outside the core.

import { CommitSha, SessionId } from "../core/ids";
import type { Command, Config, Delivered, Input, Intent, TaskId } from "../core/types";
import { Loop, type Tools } from "../loop/loop";
import { EventStore } from "../store/store";

// What goes wrong for one task. Anything left out goes well.
export type Behaviour = {
  intent?: Intent;
  changes?: number; // how many times the tester asks for changes
  conflicts?: number; // how many times merging main conflicts
};

// Something waiting to reach the loop: a tool's reply, which finishes its
// command once sent, or an agent's next report.
type Job = { taskId: TaskId; input: Input; finished?: () => void; agent: boolean };

export class Simulator {
  // The most agents ever live at once, from their start to their stop.
  mostAgentsAtOnce = 0;

  private readonly store = EventStore.open(":memory:");
  private loop: Loop;
  private queue: Job[] = [];
  private readonly behaviours = new Map<TaskId, Required<Behaviour>>();
  private readonly live = new Set<SessionId>();
  private readonly started = new Set<string>(); // "task:request" of each session started
  private now = 1_000;
  private commits = 0;

  constructor(private readonly config: Config) {
    this.loop = new Loop(config, this.tools(), this.store);
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
    this.loop.send(taskId, input, this.tick());
  }

  // Runs until nothing is left to do, or for at most `steps` steps. When
  // nothing waits, the loop starts what the scheduler picks.
  run(limit: { steps?: number } = {}): void {
    for (let step = 0; step < (limit.steps ?? 10_000); step++) {
      if (this.queue.length === 0 && this.loop.startWaiting(this.tick()).length === 0) {
        if (this.queue.length === 0) return;
      }
      const job = this.queue.shift();
      if (job === undefined) continue;
      this.loop.send(job.taskId, job.input, this.tick());
      job.finished?.();
    }
  }

  // The daemon restarts. Work the tools hadn't finished is lost, and the
  // reopened loop sends it again from the outbox. Agents keep running, as
  // they do in tmux, so their next reports still arrive.
  restart(): void {
    this.queue = this.queue.filter((job) => job.agent);
    const opened = Loop.open(this.config, this.tools(), this.store);
    if (!opened.ok) throw new Error(opened.reason);
    this.loop = opened.loop;
  }

  // How the task ended, or null while it hasn't.
  outcome(taskId: TaskId): string | null {
    const task = this.loop.task(taskId);
    return task?.phase === "ended" ? task.outcome.kind : null;
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
    return { carryOut: (command, finished) => this.carryOut(command, finished) };
  }

  // The reply goes first, so a new agent's report arrives after its start.
  private carryOut(command: Command, finished: () => void): void {
    if (command.type === "stop_session") this.live.delete(command.session);
    const reply = this.replyTo(command);
    if (reply === null) finished();
    else this.queue.push({ taskId: reply.taskId, input: reply.input, finished, agent: false });
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
    this.queue.push({ taskId: command.taskId, input: next, agent: true });
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
