// Evolve: folds one event into a task. It only applies facts that decide
// already accepted, so it holds no rules of its own. Replaying a task's
// events through it, starting from null, rebuilds the task exactly.
//
// An event that doesn't fit is refused with the reason, so a damaged log
// stops replay instead of rebuilding a wrong task.

import type { TaskIn } from "./task";
import type { Evolve, Evolved, Task, TaskBase, TaskEvent } from "./types";

export const evolve: Evolve = (task, event) => {
  if (event.type === "task.received") {
    if (task !== null) return refuse(event, `#${event.taskId} already exists`);
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
      return ok({
        ...base,
        phase: "triage",
        workspace: null,
        step: { kind: "queued" },
        override: { intent: null, rigor: null, approve: null },
      });
    }
    return ok({
      ...base,
      phase: "build",
      plan: event.plan,
      workspace: null,
      step: { kind: "queued" },
      loops: 0,
      feedback: null,
      handover: null,
      reviewed: null,
    });
  }
  if (task === null) return refuse(event, `#${event.taskId} doesn't exist`);

  // Events that apply in any phase.
  switch (event.type) {
    // A held task's agent is stopped, so its question goes with it, and the
    // step goes back to the queue for a retry.
    case "task.held": {
      if (task.hold !== null) return refuse(event, `#${task.id} is already held`);
      const rested = rest(task);
      if (rested === null) return refuse(event, `#${task.id} has ended`);
      return ok({ ...rested, hold: event.hold, question: null, keptAnswer: null });
    }
  }

  switch (task.phase) {
    case "triage":
      return inTriage(task, event);
    default:
      return refuse(event, "it isn't handled yet");
  }
};

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
      if (task.step.kind !== "starting")
        return refuse(event, `#${task.id} isn't starting a session`);
      return ok({ ...task, step: { kind: "running", session: event.session } });
    default:
      return refuse(event, `#${task.id} is in triage`);
  }
}

// A step that sends a request records the number the event gives it, so only
// the reply that brings it back can answer. The counter follows it. Typing the
// step as T["step"] makes the compiler check it fits the task's phase.
function withRequest<T extends Extract<Task, { step: unknown }>>(
  task: T,
  request: number,
  step: T["step"],
): T {
  return { ...task, step, requests: request };
}

// The task with its step back in the queue, or null for an ended task.
function rest(task: Task): Task | null {
  switch (task.phase) {
    case "triage":
      return { ...task, step: { kind: "queued" } };
    default:
      return null;
  }
}

function ok(task: Task): Evolved {
  return { ok: true, task };
}

function refuse(event: TaskEvent, why: string): Evolved {
  return { ok: false, reason: `${event.type} can't apply: ${why}.` };
}
