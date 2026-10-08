// Evolve: folds one event into a task. It only applies facts that decide
// already accepted, so it holds no rules of its own. Replaying a task's
// events through it, starting from null, rebuilds the task exactly.
//
// Events that apply in any phase come first, then one function per phase.
// An event that doesn't fit is refused with the reason, so a damaged log
// stops replay instead of rebuilding a wrong task.

import type { TaskIn } from "./task";
import type {
  Evolve,
  Evolved,
  Hold,
  Outcome,
  Plan,
  Proposal,
  Reviewed,
  Task,
  TaskBase,
  TaskEvent,
} from "./types";

export const evolve: Evolve = (task, event) => {
  if (event.type === "task.received") {
    if (task !== null) return refuse(event, `#${event.taskId} already exists`);
    return ok(received(event));
  }
  if (task === null) return refuse(event, `#${event.taskId} doesn't exist`);

  switch (event.type) {
    // A held task's agent is stopped, so its question goes with it, and the
    // step goes back to the queue for a retry.
    case "task.held": {
      if (task.hold !== null) return refuse(event, `#${task.id} is already held`);
      const rested = rest(task, event.hold);
      if (rested === null) return refuse(event, `#${task.id} has ended`);
      return ok({ ...rested, hold: event.hold, question: null, keptAnswer: null });
    }

    case "question.asked":
      if (task.question !== null) return refuse(event, `#${task.id} already has an open question`);
      return ok({ ...task, question: event.question });

    // The question stays open until the answer reaches the agent.
    case "answer.kept":
      if (task.question === null) return refuse(event, `#${task.id} has no open question`);
      return ok({ ...task, keptAnswer: { text: event.text, keptAt: event.at } });

    case "question.answered":
      if (task.question === null) return refuse(event, `#${task.id} has no open question`);
      return ok({ ...task, question: null, keptAnswer: null });

    // The task keeps its slot until the stop is confirmed.
    case "session.stopping":
      return ok({
        ...task,
        stopping: { session: event.session, request: event.request },
        requests: Math.max(task.requests, event.request),
      });

    // An ended task's workspace was removed with the stop, unless the save
    // failed. Then it stays, so no work is thrown away.
    case "session.stopped":
      if (task.stopping === null) return refuse(event, `#${task.id} isn't stopping an agent`);
      if (task.phase === "ended" && event.saved !== "save_failed") {
        return ok({ ...task, stopping: null, kept: null });
      }
      return ok({ ...task, stopping: null });
  }

  switch (task.phase) {
    case "triage":
      return inTriage(task, event);
    case "build":
      return inBuild(task, event);
    case "review":
      return inReview(task, event);
    default:
      return refuse(event, `#${task.id} can't take it in ${task.phase}`);
  }
};

// A new task: in triage's queue, or in build's when you gave intent and rigor.
function received(event: Extract<TaskEvent, { type: "task.received" }>): Task {
  const base: TaskBase = {
    id: event.taskId,
    source: event.source,
    title: event.title,
    description: event.description,
    createdAt: event.at,
    question: null,
    keptAnswer: null,
    hold: null,
    attached: false,
    lane: "queued",
    stopping: null,
    requests: 0,
    usage: {},
  };
  if (event.plan === null) {
    return {
      ...base,
      phase: "triage",
      workspace: null,
      step: { kind: "queued" },
      override: { intent: null, rigor: null, approve: null },
    };
  }
  return {
    ...base,
    phase: "build",
    plan: event.plan,
    workspace: null,
    step: { kind: "queued" },
    loops: 0,
    feedback: null,
    handover: null,
    reviewed: null,
  };
}

// ---------------------------------------------------------------------------
// The phases
// ---------------------------------------------------------------------------

function inTriage(task: TaskIn<"triage">, event: TaskEvent): Evolved {
  switch (event.type) {
    case "workspace.requested":
      return ok(
        withRequest(task, event.request, { kind: "creating_workspace", request: event.request }),
      );

    case "workspace.created":
      return ok({ ...task, workspace: event.workspace });

    case "session.requested":
      return ok(withRequest(task, event.request, { kind: "starting", request: event.request }));

    case "session.started":
      if (task.step.kind !== "starting") {
        return refuse(event, `#${task.id} isn't starting a session`);
      }
      return ok({ ...task, step: { kind: "running", session: event.session } });

    // Without a spec, the task moves to build and waits for the planner's
    // stop. With one, it stays until the spec is committed.
    case "task.triaged":
      switch (event.outcome) {
        case "proceed":
          if (event.spec === null) return ok(toBuild(task, event.plan));
          return ok(
            withRequest(task, event.spec.request, {
              kind: "committing_spec",
              request: event.spec.request,
              plan: event.plan,
              text: event.spec.text,
            }),
          );
        case "split": {
          const proposals: Proposal[] = event.proposals.map((proposal) => ({
            ...proposal,
            decision: "pending",
          }));
          return ok(toEnded(task, { kind: "split" }, proposals));
        }
        case "decline":
          return ok(toEnded(task, { kind: "declined", reason: event.reason }, []));
      }
      break;

    case "spec.committed":
      if (task.step.kind !== "committing_spec") {
        return refuse(event, `#${task.id} isn't committing a spec`);
      }
      return ok(toBuild(task, { ...task.step.plan, specPath: event.path }));
  }
  return refuse(event, `#${task.id} is in triage`);
}

function inBuild(task: TaskIn<"build">, event: TaskEvent): Evolved {
  switch (event.type) {
    case "workspace.requested":
      return ok(
        withRequest(task, event.request, { kind: "creating_workspace", request: event.request }),
      );

    case "workspace.created":
      return ok({ ...task, workspace: event.workspace });

    case "session.requested":
      return ok(withRequest(task, event.request, { kind: "starting", request: event.request }));

    case "session.started":
      if (task.step.kind !== "starting") {
        return refuse(event, `#${task.id} isn't starting a session`);
      }
      return ok({ ...task, step: { kind: "running", session: event.session } });

    // The builder's work is kept until delivery. The feedback it started
    // with has been dealt with.
    case "build.done":
      return ok({
        ...task,
        handover: event.handover,
        feedback: null,
        step: { kind: "awaiting_stop" },
      });

    case "main.requested":
      return ok(withRequest(task, event.request, { kind: "merging_main", request: event.request }));

    case "main.merged":
    case "review.ready": {
      const reviewing = toReview(task, event.reviewed);
      if (reviewing === null) return refuse(event, `#${task.id} has no handed-over work`);
      return ok(reviewing);
    }

    // A fresh builder finishes the merge. What it handed over before is
    // replaced by what it hands over next.
    case "main.conflict":
      return ok({
        ...task,
        loops: task.loops + 1,
        feedback: { kind: "conflict", files: event.files },
        handover: null,
      });
  }
  return refuse(event, `#${task.id} is in build`);
}

function inReview(task: TaskIn<"review">, event: TaskEvent): Evolved {
  switch (event.type) {
    case "workspace.requested":
      return ok(
        withRequest(task, event.request, { kind: "creating_copy", request: event.request }),
      );
  }
  return refuse(event, `#${task.id} is in review`);
}

// ---------------------------------------------------------------------------
// Moving between phases
// ---------------------------------------------------------------------------
//
// A move is built from the base fields plus the new phase's own, never by
// spreading the old phase, so nothing from the old phase is left behind.

// The fields every task has, whatever its phase.
function base(task: Task): TaskBase {
  return {
    id: task.id,
    source: task.source,
    title: task.title,
    description: task.description,
    createdAt: task.createdAt,
    question: task.question,
    keptAnswer: task.keptAnswer,
    hold: task.hold,
    attached: task.attached,
    lane: task.lane,
    stopping: task.stopping,
    requests: task.requests,
    usage: task.usage,
  };
}

// From triage into build, in the same workspace, waiting for the planner's
// stop.
function toBuild(task: TaskIn<"triage">, plan: Plan): Task {
  return {
    ...base(task),
    phase: "build",
    plan,
    workspace: task.workspace,
    step: { kind: "awaiting_stop" },
    loops: 0,
    feedback: null,
    handover: null,
    reviewed: null,
  };
}

// From build into review, with the one commit review, approval and delivery
// all use. Null if nothing was handed over, which decide never allows.
function toReview(task: TaskIn<"build">, reviewed: Reviewed): Task | null {
  if (task.handover === null || task.workspace === null) return null;
  return {
    ...base(task),
    phase: "review",
    plan: task.plan,
    workspace: task.workspace,
    step: { kind: "queued" },
    loops: task.loops,
    handover: task.handover,
    reviewed,
    copy: null,
    evidence: null,
  };
}

// The task ends. Its question and attachment go with it. The workspace is
// tracked until its removal is confirmed.
function toEnded(task: TaskIn<"triage">, outcome: Outcome, proposals: Proposal[]): Task {
  return {
    ...base(task),
    question: null,
    keptAnswer: null,
    attached: false,
    phase: "ended",
    outcome,
    proposals,
    kept: task.workspace,
  };
}

// Where a held task waits. Its agent is stopped, so a step with an agent goes
// back to the queue, for a fresh one after your retry. A failed merge or
// delivery keeps its step, so your retry sends it again. Null for an ended
// task, which can't be held.
function rest(task: Task, hold: Hold): Task | null {
  if (task.phase === "ended") return null;
  const resend = hold.kind === "failed" && (hold.step === "merge_main" || hold.step === "delivery");
  if (resend) return task;
  switch (task.phase) {
    case "triage":
      return { ...task, step: { kind: "queued" } };
    case "build":
      return { ...task, step: { kind: "queued" } };
    case "review":
      return { ...task, step: { kind: "queued" } };
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// A step that sends a request records the number the event gives it, so only
// the reply that brings it back can answer. The counter follows it. Typing the
// step as T["step"] makes the compiler check it fits the task's phase.
function withRequest<T extends Extract<Task, { step: unknown }>>(
  task: T,
  request: number,
  step: T["step"],
): T {
  return { ...task, step, requests: Math.max(task.requests, request) };
}

function ok(task: Task): Evolved {
  return { ok: true, task };
}

function refuse(event: TaskEvent, why: string): Evolved {
  return { ok: false, reason: `${event.type} can't apply: ${why}.` };
}
