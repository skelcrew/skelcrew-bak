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
