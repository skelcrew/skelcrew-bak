// Decide: the only place a task can change. It checks one input against the
// task, the config and the rules, then accepts it with events and commands,
// or rejects it with a reason. It reads nothing else and changes nothing.
//
// `decide` below is the outline: each step is one line, in the order the
// rules apply. The steps follow it.

import { runningSession, type TaskIn, waitingForSession } from "./task";
import type {
  Command,
  Decide,
  Decision,
  Envelope,
  EventBody,
  Hold,
  Input,
  Plan,
  SessionContext,
  SessionId,
  Task,
  Timestamp,
  Workspace,
} from "./types";

// What every step needs besides the task and the input.
type Context = {
  accept: (bodies: EventBody[], commands?: Command[]) => Decision;
  reject: (reason: string) => Decision;
  at: Timestamp;
};

export const decide: Decide = (task, envelope) => {
  const ctx = makeContext(envelope);
  const { input } = envelope;

  if (input.type === "add") return create(task, input, ctx);
  if (task === null) return ctx.reject(`#${envelope.taskId} doesn't exist.`);

  const mismatch = senderMismatch(task, input);
  if (mismatch !== null) return ctx.reject(mismatch);

  if (worksInAnyPhase(input)) return inAnyPhase(task, input, ctx);

  switch (task.phase) {
    case "triage":
      return inTriage(task, input, ctx);
    case "ended":
      return ctx.reject(`#${task.id} has ended.`);
    default:
      return ctx.reject(`Skelcrew can't take ${input.type} yet.`);
  }
};

function makeContext({ taskId, at, input }: Envelope): Context {
  return {
    accept: (bodies, commands = []) => ({
      ok: true,
      events: bodies.map((body) => ({ ...body, v: 1, taskId, at })),
      commands,
    }),
    reject: (reason) => ({ ok: false, rejection: { input: input.type, reason } }),
    at,
  };
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

// A task you add yourself. With intent and rigor given, it skips triage, and
// its brief is its title and description.
function create(task: Task | null, input: Input & { type: "add" }, ctx: Context): Decision {
  if (task !== null) return ctx.reject(`#${task.id} already exists.`);
  if (isBlank(input.title)) return ctx.reject("A task needs a title.");
  const plan: Plan | null =
    input.plan === null
      ? null
      : { ...input.plan, brief: brief(input.title, input.description), specPath: null };
  return ctx.accept([
    {
      type: "task.received",
      title: input.title,
      description: input.description,
      source: { kind: "local" },
      plan,
    },
  ]);
}

// Inputs whose rules don't depend on the phase.
const anyPhaseInputs = ["session_ended", "stopped", "ask", "reply", "deliver_answer"] as const;
type AnyPhaseInput = Extract<Input, { type: (typeof anyPhaseInputs)[number] }>;

function worksInAnyPhase(input: Input): input is AnyPhaseInput {
  return anyPhaseInputs.some((type) => type === input.type);
}

function inAnyPhase(task: Task, input: AnyPhaseInput, ctx: Context): Decision {
  switch (input.type) {
    // A session that ends without reporting has crashed or quit, so the task
    // is held with what it last printed. The report names the session, so an
    // old session's end can't hold the task. It also names the request that
    // started the session, so an end that arrives before the start reply
    // still counts.
    case "session_ended": {
      const current = runningSession(task) === input.session;
      if (!current && !waitingForSession(task, input.request)) {
        return ctx.reject(`#${task.id}'s agent isn't ${input.session}.`);
      }
      return ctx.accept([
        {
          type: "task.held",
          hold: { kind: "crashed", exitCode: input.exitCode, lastLine: input.lastLine },
        },
      ]);
    }

    // The stop of an agent the task let go is confirmed. Its work is saved,
    // so the next agent can start. A failed save holds the task, and its
    // workspace is never removed.
    case "stopped": {
      const { stopping } = task;
      if (stopping === null || stopping.request !== input.request) {
        return ctx.reject(notWaitingFor(task, input.request));
      }
      const confirmed: EventBody = {
        type: "session.stopped",
        session: stopping.session,
        saved: input.saved,
      };
      if (input.saved === "save_failed" && task.phase !== "ended") {
        const hold: Hold = { kind: "failed", step: "save", message: input.message };
        return ctx.accept([confirmed, { type: "task.held", hold }]);
      }
      if (
        task.phase === "build" &&
        task.step.kind === "awaiting_stop" &&
        task.hold === null &&
        task.workspace !== null
      ) {
        const builder = startBuilder(
          { workspace: task.workspace, plan: task.plan },
          task,
          next(task),
        );
        return ctx.accept([confirmed, ...builder.events], builder.commands);
      }
      return ctx.accept([confirmed]);
    }

    // One open question per task, so you are never flooded by one task.
    // Options make an answer one tap.
    case "ask": {
      if (task.question !== null) return ctx.reject(`#${task.id} already has an open question.`);
      if (input.options.length < 2 || input.options.length > 4) {
        return ctx.reject("A question needs two to four options.");
      }
      const question = {
        session: input.session,
        text: input.text,
        options: input.options,
        askedAt: ctx.at,
      };
      return ctx.accept([{ type: "question.asked", question }]);
    }

    // The agent works again as soon as it reads your answer, so the answer
    // waits on the task until the scheduler finds it a slot.
    case "reply":
      if (task.question === null) return ctx.reject(`#${task.id} has no open question.`);
      if (task.keptAnswer !== null) {
        return ctx.reject(`#${task.id} is already answered. Your answer waits for a slot.`);
      }
      if (isBlank(input.text)) return ctx.reject("A reply needs text.");
      return ctx.accept([{ type: "answer.kept", text: input.text }]);

    // The scheduler found a slot: the kept answer is typed into the session
    // of the agent that asked.
    case "deliver_answer": {
      if (task.keptAnswer === null) return ctx.reject(`#${task.id} has no answer waiting.`);
      const session = runningSession(task);
      if (session === null) return ctx.reject(`#${task.id} has no agent running.`);
      const { text } = task.keptAnswer;
      return ctx.accept(
        [{ type: "question.answered", text }],
        [{ type: "type_into_session", session, text }],
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The phases
// ---------------------------------------------------------------------------

function inTriage(task: TaskIn<"triage">, input: Input, ctx: Context): Decision {
  switch (input.type) {
    // The scheduler picked the task. Its workspace is made first.
    case "start": {
      if (task.step.kind !== "queued") return ctx.reject(`#${task.id} isn't waiting for a slot.`);
      const request = next(task);
      return ctx.accept(
        [{ type: "workspace.requested", request, tester: false }],
        [{ type: "create_workspace", taskId: task.id, request }],
      );
    }

    // The planner starts in the new workspace, read only.
    case "workspace_created": {
      if (task.step.kind !== "creating_workspace" || task.step.request !== input.request) {
        return ctx.reject(notWaitingFor(task, input.request));
      }
      const request = next(task);
      return ctx.accept(
        [
          { type: "workspace.created", workspace: input.workspace },
          { type: "session.requested", request, role: "planner" },
        ],
        [
          {
            type: "start_session",
            taskId: task.id,
            request,
            role: "planner",
            cwd: input.workspace.path,
            edits: false,
            context: sessionContext(task, null),
          },
        ],
      );
    }

    case "workspace_failed": {
      if (task.step.kind !== "creating_workspace" || task.step.request !== input.request) {
        return ctx.reject(notWaitingFor(task, input.request));
      }
      return ctx.accept([
        { type: "task.held", hold: { kind: "failed", step: "workspace", message: input.message } },
      ]);
    }

    case "session_started":
      if (!waitingForSession(task, input.request)) {
        return ctx.reject(notWaitingFor(task, input.request));
      }
      return ctx.accept([{ type: "session.started", session: input.session }]);

    case "session_failed":
      if (!waitingForSession(task, input.request)) {
        return ctx.reject(notWaitingFor(task, input.request));
      }
      return ctx.accept([
        { type: "task.held", hold: { kind: "failed", step: "session", message: input.message } },
      ]);

    // The planner's call. Your overrides win over it, field by field. The
    // planner is stopped, and the builder starts once the stop is confirmed.
    // A spec is committed by Skelcrew meanwhile, since the planner can't edit.
    case "triage_proceed": {
      if (task.question !== null) {
        return ctx.reject(`#${task.id} has an open question. Wait for the answer.`);
      }
      const { override, workspace } = task;
      if (workspace === null) return ctx.reject(`#${task.id} has no workspace.`);
      const plan: Plan = {
        intent: override.intent ?? input.plan.intent,
        rigor: override.rigor ?? input.plan.rigor,
        approve: override.approve ?? input.plan.approve,
        brief: input.plan.brief,
        specPath: null,
      };
      const stop = stopAgent(task, input.session, next(task), false, null);
      if (input.spec === null) {
        return ctx.accept(
          [{ type: "task.triaged", outcome: "proceed", plan, spec: null }, ...stop.events],
          stop.commands,
        );
      }
      const request = next(task) + 1;
      return ctx.accept(
        [
          { type: "task.triaged", outcome: "proceed", plan, spec: { text: input.spec, request } },
          ...stop.events,
        ],
        [
          ...stop.commands,
          {
            type: "commit_spec",
            taskId: task.id,
            request,
            workspace,
            text: input.spec,
          },
        ],
      );
    }

    // The task ends here. The planner is stopped, and the workspace and its
    // branch are removed with it, since nothing was built.
    case "triage_split":
    case "triage_decline": {
      if (task.question !== null) {
        return ctx.reject(`#${task.id} has an open question. Wait for the answer.`);
      }
      if (task.workspace === null) return ctx.reject(`#${task.id} has no workspace.`);
      const remove = { path: task.workspace.path, deleteBranch: true };
      const stop = stopAgent(task, input.session, next(task), false, remove);
      const triaged: EventBody =
        input.type === "triage_split"
          ? { type: "task.triaged", outcome: "split", proposals: input.proposals }
          : { type: "task.triaged", outcome: "decline", reason: input.reason };
      return ctx.accept([triaged, ...stop.events], stop.commands);
    }

    // The spec is on the branch. The builder starts now, unless the planner's
    // stop is still on its way.
    case "spec_committed": {
      const { step } = task;
      if (step.kind !== "committing_spec" || step.request !== input.request) {
        return ctx.reject(notWaitingFor(task, input.request));
      }
      const committed: EventBody = { type: "spec.committed", path: input.path };
      if (task.stopping !== null || task.hold !== null || task.workspace === null) {
        return ctx.accept([committed]);
      }
      const builder = startBuilder(
        { workspace: task.workspace, plan: { ...step.plan, specPath: input.path } },
        task,
        next(task),
      );
      return ctx.accept([committed, ...builder.events], builder.commands);
    }

    case "spec_failed": {
      const { step } = task;
      if (step.kind !== "committing_spec" || step.request !== input.request) {
        return ctx.reject(notWaitingFor(task, input.request));
      }
      return ctx.accept([
        { type: "task.held", hold: { kind: "failed", step: "spec", message: input.message } },
      ]);
    }

    default:
      return ctx.reject(`Skelcrew can't take ${input.type} yet.`);
  }
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

type Effects = { events: EventBody[]; commands: Command[] };

// Stops an agent the task lets go. With `save`, its uncommitted work is
// committed after it stops. `remove` is a workspace to remove after that,
// unless the save failed. The task keeps its slot until the stop is confirmed.
function stopAgent(
  task: Task,
  session: SessionId,
  request: number,
  save: boolean,
  remove: { path: string; deleteBranch: boolean } | null,
): Effects {
  return {
    events: [{ type: "session.stopping", session, request }],
    commands: [{ type: "stop_session", taskId: task.id, request, session, save, remove }],
  };
}

// Starts a builder in the task's workspace. It may edit, except on an
// `answer` task, which never changes code.
function startBuilder(
  work: { workspace: Workspace; plan: Plan },
  task: Task,
  request: number,
): Effects {
  return {
    events: [{ type: "session.requested", request, role: "builder" }],
    commands: [
      {
        type: "start_session",
        taskId: task.id,
        request,
        role: "builder",
        cwd: work.workspace.path,
        edits: work.plan.intent !== "answer",
        context: sessionContext(task, work.plan),
      },
    ],
  };
}

// A report from an agent that isn't the task's current one: the reason, or
// null for one that is, and for anything not from an agent. So a builder
// can't pass its own review, and an old session can't act on new work.
function senderMismatch(task: Task, input: Input): string | null {
  if (input.by !== "agent") return null;
  const current = runningSession(task);
  if (current === null) return `#${task.id} has no agent running.`;
  if (current !== input.session) return `#${task.id}'s agent isn't ${input.session}.`;
  return null;
}

// What a new session is told, on top of its role's preamble.
function sessionContext(task: Task, plan: Plan | null): SessionContext {
  return { title: task.title, description: task.description, plan, feedback: null, answer: null };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// The number for the task's next request. The event that records a request
// and the command that sends it both use it. An input that sends two takes
// this one and the one after.
function next(task: Task): number {
  return task.requests + 1;
}

// Why a reply is refused: it answers a request the task isn't waiting on.
function notWaitingFor(task: Task, request: number): string {
  return `This reply answers request ${request}, but #${task.id} isn't waiting on it.`;
}

function brief(title: string, description: string | null): string {
  return description === null ? title : `${title}\n\n${description}`;
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}
