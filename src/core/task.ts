// Reading a task. decide, evolve, the scheduler and the tests all read tasks
// through here, so a question about a task has one answer.

import type { Task } from "./types";

// A task in one phase, for example TaskIn<"triage">.
export type TaskIn<P extends Task["phase"]> = Extract<Task, { phase: P }>;
