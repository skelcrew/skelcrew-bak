// Finishing a task: your sign-off and delivery. These are the last steps of
// whichever phase ran last: review, or build for a `try`.

import picomatch from "picomatch";
import { type Context, held, isBlank, next, notWaitingFor } from "./context";
import { deliver, type Effects, removeWorkspace } from "./effects";
import type { TaskIn } from "./task";
import type {
  Config,
  Decision,
  Delivered,
  EventBody,
  Handover,
  Input,
  Plan,
  Reviewed,
  Task,
} from "./types";

// After review passes, or a `try` merges: your sign-off first when the task
// is flagged or touches a critical path, otherwise delivery.
export function afterVerdict(
  task: Task,
  plan: Plan,
  reviewed: Reviewed,
  handover: Handover,
  evidence: string | null,
  request: number,
  config: Config,
): Effects {
  const critical = criticalFiles(reviewed.changedFiles, config.critical);
  if (plan.approve || critical.length > 0) {
    return { events: [{ type: "approval.requested", criticalFiles: critical }], commands: [] };
  }
  return deliver(task, plan, reviewed, handover, evidence, request);
}

// Your sign-off, and delivery's replies, in either phase that can finish.
// Null for any other input.
export function signOffAndDelivery(
  task: TaskIn<"build" | "review">,
  input: Input,
  ctx: Context,
  handover: Handover | null,
  evidence: string | null,
): Decision | null {
  const { step, reviewed } = task;
  switch (input.type) {
    case "approve": {
      if (step.kind !== "awaiting_approval" || reviewed === null || handover === null) {
        return ctx.reject(`#${task.id} isn't waiting for your sign-off.`);
      }
      if (task.hold !== null) return ctx.reject(`#${task.id} is held. Resume it first.`);
      const out = deliver(task, task.plan, reviewed, handover, evidence, next(task));
      return ctx.accept(
        [{ type: "approval.given", commit: reviewed.head }, ...out.events],
        out.commands,
      );
    }

    // Back to build with your note, for a fresh builder when a slot is free.
    // Not a failure, so it isn't a loop.
    case "deny":
      if (step.kind !== "awaiting_approval") {
        return ctx.reject(`#${task.id} isn't waiting for your sign-off.`);
      }
      if (task.hold !== null) return ctx.reject(`#${task.id} is held. Resume it first.`);
      if (isBlank(input.note)) return ctx.reject("A denial needs a note.");
      return ctx.accept([{ type: "approval.denied", note: input.note }]);

    // Delivered: the task is done, and its workspace is removed. The branch
    // stays, since it holds the work.
    case "delivered": {
      if (step.kind !== "delivering" || step.request !== input.request) {
        return ctx.reject(notWaitingFor(task, input.request));
      }
      const wrong = deliveryMismatch(task, input.delivered);
      if (wrong !== null)
        return ctx.accept([held({ kind: "failed", step: "delivery", message: wrong })]);
      const done: EventBody = { type: "output.delivered", delivered: input.delivered };
      if (task.workspace === null || task.unsaved) return ctx.accept([done]);
      const removal = removeWorkspace(task.workspace.path);
      return ctx.accept([done, ...removal.events], removal.commands);
    }

    case "delivery_failed":
      if (step.kind !== "delivering" || step.request !== input.request) {
        return ctx.reject(notWaitingFor(task, input.request));
      }
      return ctx.accept([held({ kind: "failed", step: "delivery", message: input.message })]);

    default:
      return null;
  }
}

// Why a delivery doesn't match what was reviewed, or null if it does. It
// must be exactly the reviewed commit, as a report for an `answer` and a
// branch otherwise.
export function deliveryMismatch(
  task: TaskIn<"build" | "review">,
  delivered: Delivered,
): string | null {
  const reviewed = task.reviewed;
  if (reviewed === null) return `#${task.id} has no reviewed commit.`;
  const kind = task.plan.intent === "answer" ? "report" : "branch";
  if (delivered.kind !== kind)
    return `Delivered a ${delivered.kind}, but #${task.id} hands over a ${kind}.`;
  if (delivered.commit !== reviewed.head) {
    return `Delivered ${delivered.commit}, but the reviewed commit is ${reviewed.head}.`;
  }
  return null;
}

// The changed files that match a critical path, so your sign-off says why it
// is needed. `dot` makes ** match hidden files too, such as src/auth/.env, and
// `windows: false` fixes the separator, so every machine gives one answer.
export function criticalFiles(files: string[], critical: string[]): string[] {
  const matchers = critical.map((glob) => picomatch(glob, { dot: true, windows: false }));
  return files.filter((file) => matchers.some((matches) => matches(file)));
}
