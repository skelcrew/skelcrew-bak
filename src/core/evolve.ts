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
  Feedback,
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
      const rested = rest(task);
      if (rested === null) return refuse(event, `#${task.id} has ended`);
      return ok({
        ...rested,
        hold: event.hold,
        question: null,
        keptAnswer: null,
        attached: false,
        lane: "queued",
      });
    }

    // Your resume puts the task ahead of other queued work. A retry doesn't.
    case "task.released":
      if (task.hold === null) return refuse(event, `#${task.id} isn't held`);
      return ok({ ...task, hold: null, lane: task.hold.kind === "paused" ? "resumed" : task.lane });

    case "task.killed":
      if (task.phase === "ended") return refuse(event, `#${task.id} has ended`);
      return ok(toEnded(task, { kind: "killed" }, []));

    // Facts for the record. The input that follows in the same decision does
    // the work.
    case "task.started_now":
    case "agent.progress":
      return ok(task);

    case "usage.recorded":
      return ok({ ...task, usage: { ...task.usage, [event.session]: event.usage } });

    case "session.attached":
      return ok({ ...task, attached: true });

    case "session.detached":
      return ok({ ...task, attached: false });

    // During triage your fields wait for the planner's call. Later they
    // change the plan. A new intent is applied by build.restarted.
    case "task.set":
      switch (task.phase) {
        case "ended":
          return refuse(event, `#${task.id} has ended`);
        case "triage":
          return ok({
            ...task,
            override: {
              intent: event.intent ?? task.override.intent,
              rigor: event.rigor ?? task.override.rigor,
              approve: event.approve ?? task.override.approve,
            },
          });
        default:
          return ok({
            ...task,
            plan: {
              ...task.plan,
              rigor: event.rigor ?? task.plan.rigor,
              approve: event.approve ?? task.plan.approve,
            },
          });
      }

    case "build.restarted":
      if (task.phase === "ended") return refuse(event, `#${task.id} has ended`);
      return ok(restarted(task, event.plan, event.waitForStop));

    case "proposals.decided": {
      if (task.phase !== "ended") return refuse(event, `#${task.id} hasn't ended`);
      const proposals: Proposal[] = task.proposals.map((proposal, i) => {
        if (event.approved.includes(i)) return { ...proposal, decision: "approved" };
        if (event.denied.includes(i)) return { ...proposal, decision: "denied" };
        return proposal;
      });
      return ok({ ...task, proposals });
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
        stopping: { session: event.session, request: event.request, removes: event.removes },
        attached: false,
        requests: Math.max(task.requests, event.request),
      });

    // An ended task's workspace goes with the stop that removes it, unless
    // the save failed. Then it stays, so no work is thrown away.
    case "session.stopped": {
      const { stopping } = task;
      if (stopping === null) return refuse(event, `#${task.id} isn't stopping an agent`);
      const removed = event.saved !== "save_failed" ? stopping.removes : null;
      if (task.phase === "ended" && removed !== null && task.kept?.path === removed) {
        return ok({ ...task, stopping: null, kept: null });
      }
      return ok({ ...task, stopping: null });
    }

    case "workspace.removed":
      if (task.phase !== "ended" || task.kept?.path !== event.path) {
        return refuse(event, `#${task.id} doesn't hold ${event.path}`);
      }
      return ok({ ...task, kept: null });
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

    // Your retry sends a failed spec commit again.
    case "spec.requested":
      if (task.step.kind !== "committing_spec") {
        return refuse(event, `#${task.id} isn't committing a spec`);
      }
      return ok(withRequest(task, event.request, { ...task.step, request: event.request }));

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

    // A `try` finishes in build, so it only keeps the merged commit. Every
    // other intent moves on to review with it.
    case "main.merged":
    case "review.ready": {
      if (task.plan.intent === "try") return ok({ ...task, reviewed: event.reviewed });
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
  return finishing(task, event) ?? refuse(event, `#${task.id} is in build`);
}

function inReview(task: TaskIn<"review">, event: TaskEvent): Evolved {
  switch (event.type) {
    case "workspace.requested":
      return ok(
        withRequest(task, event.request, { kind: "creating_copy", request: event.request }),
      );

    case "copy.created":
      return ok({ ...task, copy: event.copy });

    case "session.requested":
      return ok(withRequest(task, event.request, { kind: "starting", request: event.request }));

    case "session.started":
      if (task.step.kind !== "starting") {
        return refuse(event, `#${task.id} isn't starting a session`);
      }
      return ok({ ...task, step: { kind: "running", session: event.session } });

    // The copy goes with the tester's stop, so it is no longer the task's.
    case "review.passed":
      return ok({ ...task, evidence: event.evidence, copy: null });

    // Back to build, for a fresh builder once the tester's stop is confirmed.
    case "review.changes_requested":
      return ok(
        backToBuild(task, { kind: "awaiting_stop" }, { kind: "findings", text: event.findings }, 1),
      );
  }
  return finishing(task, event) ?? refuse(event, `#${task.id} is in review`);
}

// Approval and delivery, the same in whichever phase ran last. Null for any
// other event.
function finishing(task: TaskIn<"build" | "review">, event: TaskEvent): Evolved | null {
  switch (event.type) {
    case "approval.requested":
      return ok({ ...task, step: { kind: "awaiting_approval" } });

    case "output.requested":
      return ok({
        ...task,
        step: { kind: "delivering", request: event.request },
        requests: Math.max(task.requests, event.request),
      });

    // A fact for the record. output.requested, in the same decision, moves on.
    case "approval.given":
      return ok(task);

    case "approval.denied":
      return ok(backToBuild(task, { kind: "queued" }, { kind: "denied", note: event.note }, 0));

    case "output.delivered": {
      const proposals: Proposal[] =
        task.handover?.kind === "report"
          ? task.handover.proposals.map((proposal) => ({ ...proposal, decision: "pending" }))
          : [];
      return ok(toEnded(task, { kind: "done", delivered: event.delivered }, proposals));
    }
  }
  return null;
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

// Back to build for a fresh builder, with why it is back. What was handed
// over is replaced by what the next builder hands over. `loops` counts a
// round trip through review.
function backToBuild(
  task: TaskIn<"build" | "review">,
  step: { kind: "queued" } | { kind: "awaiting_stop" },
  feedback: Feedback,
  loops: number,
): Task {
  return {
    ...base(task),
    phase: "build",
    plan: task.plan,
    workspace: task.workspace,
    step,
    loops: task.loops + loops,
    feedback,
    handover: null,
    reviewed: null,
  };
}

// Build starts over with a new plan, from any phase before the end. It waits
// for an agent's stop first, if one is stopping. The workspace and loop
// count stay.
function restarted(
  task: Exclude<Task, { phase: "ended" }>,
  plan: Plan,
  waitForStop: boolean,
): Task {
  return {
    ...base(task),
    phase: "build",
    plan,
    workspace: task.workspace,
    step: waitForStop ? { kind: "awaiting_stop" } : { kind: "queued" },
    loops: task.phase === "triage" ? 0 : task.loops,
    feedback: null,
    handover: null,
    reviewed: null,
  };
}

// The task ends. Its question and attachment go with it. The workspace is
// tracked until its removal is confirmed.
function toEnded(
  task: Exclude<Task, { phase: "ended" }>,
  outcome: Outcome,
  proposals: Proposal[],
): Task {
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

// Where a held task waits. Its agent is stopped, so a step with an agent
// goes back to the queue, for a fresh one after your resume or retry. A step
// without one stays: a failed merge or delivery is sent again by your retry,
// and an approval still waits for you. Null for an ended task.
function rest(task: Task): Task | null {
  switch (task.phase) {
    case "ended":
      return null;
    case "triage":
      return withAgent(task.step.kind) ? { ...task, step: { kind: "queued" } } : task;
    case "build":
      return withAgent(task.step.kind) ? { ...task, step: { kind: "queued" } } : task;
    case "review":
      return withAgent(task.step.kind) ? { ...task, step: { kind: "queued" } } : task;
  }
}

// Steps that start, run or stop an agent, or make its workspace.
function withAgent(kind: string): boolean {
  return (
    kind === "creating_workspace" ||
    kind === "creating_copy" ||
    kind === "starting" ||
    kind === "running" ||
    kind === "awaiting_stop"
  );
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
