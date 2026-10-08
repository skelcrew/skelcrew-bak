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
  Input,
  Plan,
  SessionContext,
  Task,
  Timestamp,
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
const anyPhaseInputs = ["session_ended", "ask", "reply", "deliver_answer"] as const;
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

    default:
      return ctx.reject(`Skelcrew can't take ${input.type} yet.`);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// The number for the task's next request. Each input sends at most one
// request, so the event that records it and the command that sends it both
// use this number.
function next(task: Task): number {
  return task.requests + 1;
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
