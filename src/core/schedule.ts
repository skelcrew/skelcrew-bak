// Schedule: picks which tasks get a free slot next. It only proposes: each
// pick becomes a "deliver_answer" or "start" input that decide can still
// reject.
//
// Finish before start: a kept answer goes first, since its agent is already
// part-way through the work. Then tasks you resumed, then the rest of the
// queue. Within each, the oldest goes first.
//
// It limits only what Skelcrew starts on its own. Your `skel start` can go
// past max_running, so this may find no slot free at all.

import type { Schedule, Task } from "./types";

export const schedule: Schedule = (tasks, config, inFlight) => {
  const free = config.maxRunning - slotsInUse(tasks, inFlight);
  if (free <= 0) return [];

  const answers = tasks
    .filter((task) => task.keptAnswer !== null && task.hold === null)
    .sort((a, b) => (a.keptAnswer?.keptAt ?? 0) - (b.keptAnswer?.keptAt ?? 0) || a.id - b.id);

  const starts = tasks
    .filter(waitingForSlot)
    .sort((a, b) => laneOrder(a) - laneOrder(b) || a.createdAt - b.createdAt || a.id - b.id);

  return [...answers, ...starts].slice(0, free).map((task) => task.id);
};

// Slots taken: tasks with an agent at work, on its way or stopping, plus
// `inFlight`. That is what the tasks themselves no longer record: a start
// sent for a task that has since moved on, and the cleanup stop of a session
// that started late. The loop counts those.
export function slotsInUse(tasks: readonly Task[], inFlight: number): number {
  return tasks.filter(holdsSlot).length + inFlight;
}

// A task holds a slot while an agent works on it, or is being started or
// stopped for it, or while a step between agents is under way. A stopping
// agent holds its slot until the stop is confirmed, even once its task is
// held or has ended. A task held, waiting for your answer or your sign-off,
// or queued holds none. An attached task keeps its slot, since its agent
// keeps working with you.
function holdsSlot(task: Task): boolean {
  if (task.stopping !== null) return true;
  if (task.phase === "ended" || task.hold !== null) return false;
  if (task.attached) return true;
  if (task.question !== null) return false;
  const { step } = task;
  switch (step.kind) {
    case "creating_workspace":
    case "creating_copy":
    case "starting":
    case "running":
    case "awaiting_stop":
      return true;
    // Null once a failure answered it, and the task waits in line again.
    case "committing_spec":
    case "merging_main":
      return step.request !== null;
    default:
      return false;
  }
}

// Waiting in line: queued, or holding a step a failure answered, which the
// next start sends again. Not held, and with no agent still stopping, since
// the next agent on a task starts only once the last one's stop is confirmed.
function waitingForSlot(task: Task): boolean {
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

function laneOrder(task: Task): number {
  return task.lane === "resumed" ? 0 : 1;
}
