// A task's lifecycle: starting, holding and ending it, and carrying on from
// where it waits once a slot is free or an agent's stop is confirmed.

import { type Context, held, next } from "./context";
import {
  createWorkspace,
  deliver,
  type Effects,
  mergeMain,
  removeWorkspace,
  startBuilder,
  startCopy,
  startPlanner,
  startTester,
  stopRunning,
} from "./effects";
import { settling, type TaskIn, waitingForSlot } from "./task";
import type { Decision, EventBody, Input, Task, Workspace } from "./types";

// Starting, holding and ending a task, from you or the scheduler.
export function lifecycle(
  task: Task,
  input: Extract<Input, { type: "start" | "start_now" | "pause" | "resume" | "retry" | "kill" }>,
  ctx: Context,
): Decision {
  switch (input.type) {
    // The scheduler picked the task for a free slot, or you started it now.
    // Either way it carries on from where it waits.
    case "start":
    case "start_now": {
      if (task.phase === "ended") return ctx.reject(`#${task.id} has ended.`);
      if (task.hold !== null) return ctx.reject(`#${task.id} is held.`);
      // A task whose last agent is still stopping isn't waiting for a slot,
      // so two agents never work on it at once.
      if (!waitingForSlot(task)) return ctx.reject(`#${task.id} isn't waiting for a slot.`);
      const go = task.step.kind === "queued" ? carryOn(task) : resend(task);
      const yours: EventBody[] = input.type === "start_now" ? [{ type: "task.started_now" }] : [];
      return ctx.accept([...yours, ...go.events], go.commands);
    }

    // The agent stops, with its work saved, and the task waits for you. A step
    // under way, such as a workspace being made, settles first: the CLI waits
    // and sends the pause again.
    case "pause": {
      if (task.phase === "ended") return ctx.reject(`#${task.id} has ended.`);
      if (task.hold !== null) return ctx.reject(`#${task.id} is already held.`);
      if (settling(task)) {
        return ctx.reject(`#${task.id} is busy with a step. skel pause waits until it settles.`);
      }
      const stop = stopRunning(task, next(task), { workspace: false, copy: false });
      return ctx.accept([held({ kind: "paused" }), ...stop.events], stop.commands);
    }

    case "resume":
      if (task.phase === "ended") return ctx.reject(`#${task.id} has ended.`);
      if (task.hold === null) return ctx.reject(`#${task.id} isn't held.`);
      if (task.hold.kind !== "paused") {
        return ctx.reject(`#${task.id} isn't paused. Retry it instead.`);
      }
      return ctx.accept([{ type: "task.released" }]);

    // Lifts a hold from anything that went wrong. A failed merge, spec or
    // delivery is sent again. Anything else waits for a slot.
    case "retry": {
      if (task.phase === "ended") return ctx.reject(`#${task.id} has ended.`);
      if (task.hold === null) return ctx.reject(`#${task.id} isn't held.`);
      if (task.hold.kind === "paused")
        return ctx.reject(`#${task.id} is paused. Resume it instead.`);
      // Back in line. A failed merge, spec commit or delivery is sent again
      // when the scheduler starts it, so a retry never goes past max_running.
      return ctx.accept([{ type: "task.released" }]);
    }

    // The task ends, whatever it was doing. A working agent is stopped with
    // its work saved, then its workspace is removed. The branch stays, since
    // it holds the work.
    case "kill": {
      if (task.phase === "ended") return ctx.reject(`#${task.id} has ended.`);
      const stop = stopRunning(task, next(task), { workspace: true, copy: true });
      const events: EventBody[] = [{ type: "task.killed" }, ...stop.events];
      const commands = [...stop.commands];
      // The workspace goes now only if nothing could still write to it: no
      // agent at work, stopping or starting in it, and no unsaved work. A
      // planner's or builder's stop removes it once its work is saved, and a
      // stop already on its way removes it when confirmed (see afterStop).
      // While a session is starting, it stays, for the late session's stop
      // to save into.
      const workspace = task.unsaved ? null : task.workspace;
      const goesWithStop = stop.events.length > 0 && task.phase !== "review";
      const starting = task.step.kind === "starting";
      if (workspace !== null && !goesWithStop && task.stopping === null && !starting) {
        const removal = removeWorkspace(workspace.path);
        events.push(...removal.events);
        commands.push(...removal.commands);
      }
      // The tester's copy goes too. A working tester's stop removes it.
      if (task.phase === "review" && task.copy !== null && stop.events.length === 0) {
        commands.push({ type: "remove_workspace", path: task.copy.path, deleteBranch: false });
      }
      return ctx.accept(events, commands);
    }
  }
}

// What happens once an agent's stop is confirmed. The next agent on a task
// only starts now, so two never work on it at once. A task killed while an
// agent was stopping removes its workspace now, once its work is safe.
export function afterStop(task: Task, removed: string | null, unsaved: boolean): Effects {
  const none: Effects = { events: [], commands: [] };
  if (task.phase === "ended") {
    const { kept } = task;
    if (kept === null || kept.path === removed || unsaved) return none;
    return removeWorkspace(kept.path);
  }
  if (task.phase !== "build" || task.step.kind !== "awaiting_stop" || task.hold !== null) {
    return none;
  }
  return carryOn(task);
}

// Starts the task's next step from where it waits: its workspace, or its
// next agent, or for a build that was handed over, the merge or review.
export function carryOn(task: Exclude<Task, { phase: "ended" }>): Effects {
  if (task.workspace === null) return createWorkspace(task, next(task));
  switch (task.phase) {
    case "triage":
      return startPlanner(task, task.workspace, next(task));
    case "review":
      // A copy left from a tester that crashed or failed to start is reused.
      if (task.copy !== null) return startTester(task, task.copy, next(task));
      return startCopy(task, task.reviewed, next(task));
    case "build":
      return carryOnBuilding(task, task.workspace);
  }
}

// A build goes on from what was handed over, so nothing is built twice.
export function carryOnBuilding(task: TaskIn<"build">, workspace: Workspace): Effects {
  const { handover } = task;

  // Nothing handed over yet: a fresh builder starts, told why it is back.
  if (handover === null) return startBuilder(task, workspace, task.plan, task.feedback, next(task));

  // An `answer` merges nothing, so its handed-over commit is reviewed as is.
  if (task.plan.intent === "answer") {
    const copy = startCopy(task, handover.branch, next(task));
    return {
      events: [{ type: "review.ready", reviewed: handover.branch }, ...copy.events],
      commands: copy.commands,
    };
  }

  // `ship` and `try` are brought up to date with main first.
  return mergeMain(task, workspace, next(task));
}

// Sends again what failed, after your retry: a merge, a spec commit, or a
// delivery. Anything else waits for a slot.
export function resend(task: Task): Effects {
  const none: Effects = { events: [], commands: [] };
  if (task.phase === "ended") return none;
  const { step } = task;
  if (step.kind === "merging_main" && task.workspace !== null) {
    return mergeMain(task, task.workspace, next(task));
  }
  if (step.kind === "committing_spec" && task.workspace !== null) {
    const request = next(task);
    return {
      events: [{ type: "spec.requested", request, text: step.text }],
      commands: [
        {
          type: "commit_spec",
          taskId: task.id,
          request,
          workspace: task.workspace,
          text: step.text,
        },
      ],
    };
  }
  if (step.kind === "delivering" && task.phase !== "triage" && task.reviewed !== null) {
    const handover = task.handover;
    if (handover === null) return none;
    const evidence = task.phase === "review" ? task.evidence : null;
    return deliver(task, task.plan, task.reviewed, handover, evidence, next(task));
  }
  return none;
}
