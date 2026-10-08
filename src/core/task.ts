// Reading a task: which agent it runs, and which request it waits on. decide,
// evolve, the scheduler and the tests all read tasks through here, so each
// question about a task has one answer.

import type { SessionId, Task } from "./types";

// A task in one phase, for example TaskIn<"triage">.
export type TaskIn<P extends Task["phase"]> = Extract<Task, { phase: P }>;

// The session of the agent working on the task now, or null if none is.
export function runningSession(task: Task): SessionId | null {
  if (task.phase === "ended") return null;
  return task.step.kind === "running" ? task.step.session : null;
}

// Whether the task waits for the session started by this request. A session
// started by an earlier request, for a step the task has left, is late.
export function waitingForSession(task: Task, request: number): boolean {
  if (task.phase === "ended") return false;
  return task.step.kind === "starting" && task.step.request === request;
}

// Whether the task waits for the workspace, or tester's copy, of this request.
export function waitingForWorkspace(task: Task, request: number): boolean {
  if (task.phase === "ended") return false;
  const { step } = task;
  return (
    (step.kind === "creating_workspace" || step.kind === "creating_copy") &&
    step.request === request
  );
}

// Whether the task waits for the merge of main of this request.
export function waitingForMerge(task: TaskIn<"build">, request: number): boolean {
  return task.step.kind === "merging_main" && task.step.request === request;
}

// Whether the task holds this workspace or tester's copy.
export function holdsWorkspace(task: Task, path: string): boolean {
  switch (task.phase) {
    case "ended":
      return task.kept?.path === path;
    case "review":
      return task.workspace.path === path || task.copy?.path === path;
    default:
      return task.workspace?.path === path;
  }
}

// Whether the task waits in line for a slot: queued, or holding a step a
// failure answered, which the next start sends again. Not held, and with no
// agent still stopping, since the next agent on a task starts only once the
// last one's stop is confirmed.
export function waitingForSlot(task: Task): boolean {
  if (task.phase === "ended" || task.hold !== null || task.stopping !== null) return false;
  const { step } = task;
  if (step.kind === "queued") return true;
  if (
    step.kind === "committing_spec" ||
    step.kind === "merging_main" ||
    step.kind === "delivering"
  ) {
    return step.request === null;
  }
  return false;
}

// Whether a step is under way that pause and set must wait for: an agent
// is stopping, or something is being made, started, merged or delivered.
export function settling(task: Exclude<Task, { phase: "ended" }>): boolean {
  if (task.stopping !== null) return true;
  switch (task.step.kind) {
    case "creating_workspace":
    case "creating_copy":
    case "starting":
      return true;
    // Null once a failure answered it, so nothing is under way.
    case "committing_spec":
    case "merging_main":
    case "delivering":
      return task.step.request !== null;
    default:
      return false;
  }
}
