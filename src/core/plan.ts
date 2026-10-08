// Changing a task's plan with `skel set`: its intent, rigor or approval.
// Also the plan of a task that skips triage.

import { type Context, next } from "./context";
import { deliver, stopRunning } from "./effects";
import { criticalFiles } from "./finish";
import type { AddPlan, Decision, EventBody, Input, Plan, Task } from "./types";

// `skel set`. Each field takes effect in its own way:
// - During triage, a field wins over the planner's call when it comes.
//   Intent and rigor together end triage, as adding with both skips it.
// - Approval applies at once. Cleared while it waits for you, the task is
//   delivered, unless a critical path still needs your sign-off.
// - Rigor applies from the next phase, since agents read it when they start.
// - A new intent restarts build with a fresh builder, since its permissions
//   change. The branch and its commits stay.
export function setPlan(
  task: Exclude<Task, { phase: "ended" }>,
  input: Input & { type: "set" },
  ctx: Context,
): Decision {
  const fields: EventBody = {
    type: "task.set",
    intent: input.intent,
    rigor: input.rigor,
    approve: input.approve,
  };

  if (task.phase === "triage") {
    const intent = input.intent ?? task.override.intent;
    const rigor = input.rigor ?? task.override.rigor;
    if (intent === null || rigor === null) return ctx.accept([fields]);
    const approve = input.approve ?? task.override.approve ?? false;
    const plan = skippingTriage({ intent, rigor, approve }, task.title, task.description);
    return restartBuild(task, plan, [fields], ctx);
  }

  const plan: Plan = {
    ...task.plan,
    intent: input.intent ?? task.plan.intent,
    rigor: input.rigor ?? task.plan.rigor,
    approve: input.approve ?? task.plan.approve,
  };
  if (plan.intent !== task.plan.intent) return restartBuild(task, plan, [fields], ctx);

  const { step, reviewed, handover } = task;
  // Set while a failed delivery waits for your retry: it now waits for your
  // sign-off first.
  const approvalSet = plan.approve && !task.plan.approve && step.kind === "delivering";
  if (approvalSet && reviewed !== null) {
    const critical = criticalFiles(reviewed.changedFiles, ctx.config.critical);
    return ctx.accept([fields, { type: "approval.requested", criticalFiles: critical }]);
  }

  const approvalLifted = step.kind === "awaiting_approval" && task.plan.approve && !plan.approve;
  if (approvalLifted && task.hold !== null) {
    return ctx.reject(`#${task.id} is held. Resume it first.`);
  }
  if (approvalLifted && reviewed !== null && handover !== null) {
    if (criticalFiles(reviewed.changedFiles, ctx.config.critical).length === 0) {
      const evidence = task.phase === "review" ? task.evidence : null;
      const out = deliver(task, plan, reviewed, handover, evidence, next(task));
      return ctx.accept([fields, ...out.events], out.commands);
    }
  }
  return ctx.accept([fields]);
}

// Build starts over with a new plan. A working agent is stopped first, and the
// fresh builder starts once that stop is confirmed. set is refused while an
// earlier stop is on its way, so that is the only stop to wait for.
export function restartBuild(
  task: Exclude<Task, { phase: "ended" }>,
  plan: Plan,
  before: EventBody[],
  ctx: Context,
): Decision {
  const stop = stopRunning(task, next(task), { workspace: false, copy: true });
  const waitForStop = stop.events.length > 0;
  // Leaving review drops the tester's copy. A working tester's stop removes
  // it. Otherwise it goes now.
  const commands = [...stop.commands];
  if (task.phase === "review" && task.copy !== null && stop.events.length === 0) {
    commands.push({ type: "remove_workspace", path: task.copy.path, deleteBranch: false });
  }
  return ctx.accept(
    [...before, ...stop.events, { type: "build.restarted", plan, waitForStop }],
    commands,
  );
}

// The plan of a task that skips triage: your intent, rigor and approval,
// with its title and description as the brief.
export function skippingTriage(yours: AddPlan, title: string, description: string | null): Plan {
  const brief = description === null ? title : `${title}\n\n${description}`;
  return { ...yours, brief, specPath: null };
}
