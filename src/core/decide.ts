// Decide: the only place a task can change. It checks one input against the
// task, the config and the rules, then accepts it with events and commands,
// or rejects it with a reason. It reads nothing else and changes nothing.
//
// `decide` below is the outline: each step is one line, in the order the
// rules apply. The steps follow it.

import type { TaskIn } from "./task";
import type { Command, Decide, Decision, Envelope, EventBody, Input, Plan, Task } from "./types";

// What every step needs besides the task and the input.
type Context = {
  accept: (bodies: EventBody[], commands?: Command[]) => Decision;
  reject: (reason: string) => Decision;
};

export const decide: Decide = (task, envelope) => {
  const ctx = makeContext(envelope);
  const { input } = envelope;

  if (input.type === "add") return create(task, input, ctx);
  if (task === null) return ctx.reject(`#${envelope.taskId} doesn't exist.`);

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

function brief(title: string, description: string | null): string {
  return description === null ? title : `${title}\n\n${description}`;
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}
