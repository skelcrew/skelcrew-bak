// Decide: the only place a task can change. It checks one input against the
// task, the config and the rules, then accepts it with events and commands,
// or rejects it with a reason. It reads nothing else and changes nothing.
//
// `decide` below is the outline: each step is one line, in the order the
// rules apply. The steps follow it: the rules for any phase, in four groups,
// then one function per phase, then changing the plan, approval and
// delivery. effects.ts builds the events and commands that start and stop
// agents and make workspaces.

import picomatch from "picomatch";
import {
  createWorkspace,
  deliver,
  type Effects,
  mergeMain,
  startBuilder,
  startCopy,
  startPlanner,
  startTester,
  stopAgent,
  stopRunning,
  stopTester,
} from "./effects";
import {
  holdsWorkspace,
  runningSession,
  type TaskIn,
  waitingForSession,
  waitingForSlot,
} from "./task";
import type {
  Command,
  Config,
  Decide,
  Decision,
  Delivered,
  Envelope,
  EventBody,
  Feedback,
  Handover,
  Hold,
  Input,
  Plan,
  Reviewed,
  SessionId,
  Task,
  Timestamp,
  Workspace,
} from "./types";

// What every step needs besides the task and the input.
type Context = {
  accept: (bodies: EventBody[], commands?: Command[]) => Decision;
  reject: (reason: string) => Decision;
  at: Timestamp;
  config: Config;
};

export const decide: Decide = (task, envelope, config) => {
  const ctx = makeContext(envelope, config);
  const { input } = envelope;

  if (input.type === "add" || input.type === "task_received") return create(task, input, ctx);
  if (task === null) return ctx.reject(`#${envelope.taskId} doesn't exist.`);
  if (task.id !== envelope.taskId) {
    return ctx.reject(`This input is for #${envelope.taskId}, but the task is #${task.id}.`);
  }

  const cleanup = lateReply(task, input, ctx);
  if (cleanup !== null) return cleanup;

  const mismatch = senderMismatch(task, input);
  if (mismatch !== null) return ctx.reject(mismatch);

  // The rules for any phase, in four groups.
  switch (input.type) {
    case "start":
    case "start_now":
    case "pause":
    case "resume":
    case "retry":
    case "kill":
      return lifecycle(task, input, ctx);
    case "set":
    case "attach":
    case "detach":
    case "decide_proposals":
    case "outside_change":
      return yourCalls(task, input, ctx);
    case "ask":
    case "reply":
    case "deliver_answer":
    case "give_up":
    case "progress":
      return conversation(task, input, ctx);
    case "workspace_failed":
    case "session_started":
    case "session_failed":
    case "session_ended":
    case "stopped":
    case "usage":
      return replies(task, input, ctx);
  }

  // Everything else depends on the phase.
  switch (task.phase) {
    case "triage":
      return inTriage(task, input, ctx);
    case "build":
      return inBuild(task, input, ctx);
    case "review":
      return inReview(task, input, ctx);
    case "ended":
      return ctx.reject(`#${task.id} has ended.`);
  }
};

function makeContext({ taskId, at, input }: Envelope, config: Config): Context {
  return {
    accept: (bodies, commands = []) => ({
      ok: true,
      events: bodies.map((body) => ({ ...body, v: 1, taskId, at })),
      commands,
    }),
    reject: (reason) => ({ ok: false, rejection: { input: input.type, reason } }),
    at,
    config,
  };
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

// A task you add, or one from the tracker. With intent and rigor given, it
// skips triage, and its brief is its title and description.
function create(
  task: Task | null,
  input: Input & { type: "add" | "task_received" },
  ctx: Context,
): Decision {
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
      source: input.type === "add" ? { kind: "local" } : input.source,
      plan,
    },
  ]);
}

// A workspace or session the task isn't waiting for: its request isn't the
// one the task's step records, such as one that arrives after the task was
// killed. It is cleaned up, and nothing is recorded, so nothing is left
// behind. A repeated reply for what the task already holds is ignored, since
// cleaning it up would stop the working agent or remove its workspace. Null
// when the task is waiting for the reply.
function lateReply(task: Task, input: Input, ctx: Context): Decision | null {
  if (input.type === "workspace_created" || input.type === "copy_created") {
    if (waitingForWorkspace(task, input.request)) return null;
    const path = input.type === "workspace_created" ? input.workspace.path : input.copy.path;
    if (holdsWorkspace(task, path)) return ctx.accept([]);
    return ctx.accept([], [{ type: "remove_workspace", path, deleteBranch: false }]);
  }
  if (input.type === "session_started") {
    if (waitingForSession(task, input.request)) return null;
    const held = runningSession(task) === input.session || task.stopping?.session === input.session;
    if (held) return ctx.accept([]);
    return ctx.accept(
      [],
      [
        {
          type: "stop_session",
          taskId: task.id,
          request: null,
          session: input.session,
          save: true,
          remove: null,
        },
      ],
    );
  }
  // Any other reply to a request the task no longer waits on changes nothing.
  if (isReply(input) && !awaits(task, input)) return ctx.accept([]);
  return null;
}

type Reply = Extract<Input, { by: "plugin"; request: number }>;

function isReply(input: Input): input is Reply {
  return input.by === "plugin" && "request" in input;
}

// Whether the task waits for this reply: its request is the one the task's
// step, or its stop on the way, records.
function awaits(task: Task, input: Reply): boolean {
  switch (input.type) {
    case "workspace_created":
    case "copy_created":
    case "workspace_failed":
      return waitingForWorkspace(task, input.request);
    case "session_started":
    case "session_failed":
      return waitingForSession(task, input.request);
    case "session_ended":
      return runningSession(task) === input.session || waitingForSession(task, input.request);
    case "stopped":
      return task.stopping?.request === input.request && task.stopping.session === input.session;
    default:
      return (
        task.phase !== "ended" && "request" in task.step && task.step.request === input.request
      );
  }
}

// Starting, holding and ending a task, from you or the scheduler.
function lifecycle(
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
      if (!waitingForSlot(task)) return ctx.reject(`#${task.id} isn't waiting for a slot.`);
      // Two agents never work on a task at once, so the last one's stop is
      // confirmed first. The scheduler skips such a task, and your start_now
      // waits: the CLI sends it again.
      if (task.stopping !== null) {
        return ctx.reject(
          `#${task.id} is still stopping its last agent. Start waits until it has.`,
        );
      }
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
        events.push({ type: "workspace.removed", path: workspace.path });
        commands.push({ type: "remove_workspace", path: workspace.path, deleteBranch: false });
      }
      // The tester's copy goes too. A working tester's stop removes it.
      if (task.phase === "review" && task.copy !== null && stop.events.length === 0) {
        commands.push({ type: "remove_workspace", path: task.copy.path, deleteBranch: false });
      }
      return ctx.accept(events, commands);
    }
  }
}

// Your other calls: overruling the planner, stepping into a session, and
// deciding on proposals. And the tracker, which can't move a task.
function yourCalls(
  task: Task,
  input: Extract<
    Input,
    { type: "set" | "attach" | "detach" | "decide_proposals" | "outside_change" }
  >,
  ctx: Context,
): Decision {
  switch (input.type) {
    // Overrules the planner's call. See setPlan.
    case "set":
      if (input.intent === null && input.rigor === null && input.approve === null) {
        return ctx.reject("Set intent, rigor or approval.");
      }
      if (task.phase === "ended") return ctx.reject(`#${task.id} has ended.`);
      if (settling(task)) {
        return ctx.reject(`#${task.id} is busy with a step. skel set waits until it settles.`);
      }
      return setPlan(task, input, ctx);

    // You step into the agent's session. It keeps working, and keeps its slot.
    case "attach":
      if (runningSession(task) === null) return ctx.reject(`#${task.id} has no agent running.`);
      if (task.attached) return ctx.reject(`#${task.id} is already attached.`);
      return ctx.accept([{ type: "session.attached" }]);

    // You step back out. The agent carries on, or you hand its work over as
    // if it had run done.
    case "detach": {
      if (!task.attached) return ctx.reject(`#${task.id} isn't attached.`);
      const detached: EventBody = { type: "session.detached", choice: input.choice };
      if (input.choice === "resume") return ctx.accept([detached]);
      const session = runningSession(task);
      if (task.phase !== "build" || session === null) {
        return ctx.reject("Only a builder's work can be handed over.");
      }
      const text = "Handed over by you.";
      const handover: Handover =
        task.plan.intent === "answer"
          ? { kind: "report", text, proposals: [], branch: input.branch }
          : { kind: "summary", text, branch: input.branch };
      const out = handOver(task, session, handover);
      return ctx.accept([detached, ...out.events], out.commands);
    }

    // Your call on tasks a split or an answer proposed. Approved ones become
    // tasks of their own. Only pending proposals can be decided.
    case "decide_proposals": {
      if (task.phase !== "ended" || task.proposals.length === 0) {
        return ctx.reject(`#${task.id} has no proposals waiting.`);
      }
      const indexes = [...input.approved, ...input.denied];
      for (const [i, index] of indexes.entries()) {
        const pending = task.proposals[index]?.decision === "pending";
        if (!pending || indexes.indexOf(index) !== i) {
          return ctx.reject(`Proposal ${index} of #${task.id} isn't waiting for you.`);
        }
      }
      return ctx.accept([
        { type: "proposals.decided", approved: input.approved, denied: input.denied },
      ]);
    }

    case "outside_change":
      return ctx.reject(
        `Tasks move only through Skelcrew. The ${input.what} in the tracker was ignored.`,
      );
  }
}

// An agent asking, your reply, and the agent's other reports.
function conversation(
  task: Task,
  input: Extract<Input, { type: "ask" | "reply" | "deliver_answer" | "give_up" | "progress" }>,
  ctx: Context,
): Decision {
  switch (input.type) {
    // One open question per task, so you are never flooded by one task.
    // Options make an answer one tap.
    case "ask": {
      if (task.question !== null) return ctx.reject(`#${task.id} already has an open question.`);
      if (input.options.length < 2 || input.options.length > 4) {
        return ctx.reject("A question needs two to four options.");
      }
      const question = {
        session: input.session,
        text: input.text,
        options: input.options,
        askedAt: ctx.at,
      };
      return ctx.accept([{ type: "question.asked", question }]);
    }

    // The agent works again as soon as it reads your answer, so the answer
    // waits on the task until the scheduler finds it a slot.
    case "reply":
      if (task.question === null) return ctx.reject(`#${task.id} has no open question.`);
      if (task.keptAnswer !== null) {
        return ctx.reject(`#${task.id} is already answered. Your answer waits for a slot.`);
      }
      if (isBlank(input.text)) return ctx.reject("A reply needs text.");
      return ctx.accept([{ type: "answer.kept", text: input.text }]);

    // The scheduler found a slot: the kept answer is typed into the session
    // of the agent that asked.
    case "deliver_answer": {
      if (task.keptAnswer === null) return ctx.reject(`#${task.id} has no answer waiting.`);
      const session = runningSession(task);
      if (session === null) return ctx.reject(`#${task.id} has no agent running.`);
      const { text } = task.keptAnswer;
      return ctx.accept(
        [{ type: "question.answered", text }],
        [{ type: "type_into_session", session, text }],
      );
    }

    // The agent can't go on. It is stopped, and the task waits for you.
    case "give_up": {
      const stop = stopRunning(task, next(task), { workspace: false, copy: false });
      return ctx.accept(
        [held({ kind: "gave_up", message: input.message }), ...stop.events],
        stop.commands,
      );
    }

    // For the log and the screen. Nothing else changes.
    case "progress":
      return ctx.accept([{ type: "agent.progress", session: input.session, text: input.text }]);
  }
}

// Replies about workspaces and sessions, and usage readings. A reply gets
// here only if the task waits for it: lateReply has dealt with any other.
function replies(
  task: Task,
  input: Extract<
    Input,
    {
      type:
        | "workspace_failed"
        | "session_started"
        | "session_failed"
        | "session_ended"
        | "stopped"
        | "usage";
    }
  >,
  ctx: Context,
): Decision {
  switch (input.type) {
    // A workspace, or the tester's copy, couldn't be made. The task waits
    // for your retry.
    case "workspace_failed":
      return ctx.accept([held({ kind: "failed", step: "workspace", message: input.message })]);

    case "session_started":
      return ctx.accept([{ type: "session.started", session: input.session }]);

    case "session_failed":
      return ctx.accept([held({ kind: "failed", step: "session", message: input.message })]);

    // A session that ends without reporting has crashed or quit, so the task
    // is held with what it last printed. The report names the session, so an
    // old session's end can't hold the task. It also names the request that
    // started the session, so an end that arrives before the start reply
    // still counts.
    case "session_ended":
      return ctx.accept([
        held({ kind: "crashed", exitCode: input.exitCode, lastLine: input.lastLine }),
      ]);

    // The stop of an agent the task let go is confirmed, with its work saved.
    // Now the task can go on: see afterStop. A failed save holds the task,
    // and its workspace is never removed.
    case "stopped": {
      const { stopping } = task;
      if (stopping === null) return ctx.reject(notWaitingFor(task, input.request));
      // Only a stop that saves can fail to save. Anything else found nothing.
      const saved =
        stopping.saves || input.saved !== "save_failed" ? input.saved : "nothing_to_save";
      const confirmed: EventBody = { type: "session.stopped", session: stopping.session, saved };
      // A task already held keeps its hold. session.stopped records the
      // failed save, and the work stays in the workspace either way.
      if (saved === "save_failed" && task.phase !== "ended" && task.hold === null) {
        return ctx.accept([
          confirmed,
          held({ kind: "failed", step: "save", message: input.message }),
        ]);
      }
      // The workspace holds unsaved work if this stop's save failed, or if
      // an earlier one did and this stop didn't save.
      const unsaved = stopping.saves ? saved === "save_failed" : task.unsaved;
      const after = afterStop(task, stopping.removes, unsaved);
      return ctx.accept([confirmed, ...after.events], after.commands);
    }

    // Running totals per session, shown and never enforced. Totals only grow,
    // so a lower report is an older one.
    case "usage": {
      const last = task.usage[input.session];
      if (
        last !== undefined &&
        (input.usage.tokens < last.tokens ||
          input.usage.cacheReads < last.cacheReads ||
          input.usage.workingMs < last.workingMs)
      ) {
        return ctx.reject(`This usage report for ${input.session} is older than the last one.`);
      }
      return ctx.accept([{ type: "usage.recorded", session: input.session, usage: input.usage }]);
    }
  }
}

// What happens once an agent's stop is confirmed. The next agent on a task
// only starts now, so two never work on it at once. A task killed while an
// agent was stopping removes its workspace now, once its work is safe.
function afterStop(task: Task, removed: string | null, unsaved: boolean): Effects {
  const none: Effects = { events: [], commands: [] };
  if (task.phase === "ended") {
    const { kept } = task;
    if (kept === null || kept.path === removed || unsaved) return none;
    return {
      events: [{ type: "workspace.removed", path: kept.path }],
      commands: [{ type: "remove_workspace", path: kept.path, deleteBranch: false }],
    };
  }
  if (task.phase !== "build" || task.step.kind !== "awaiting_stop" || task.hold !== null) {
    return none;
  }
  return carryOn(task);
}

// Starts the task's next step from where it waits: its workspace, or its
// next agent, or for a build that was handed over, the merge or review.
function carryOn(task: Exclude<Task, { phase: "ended" }>): Effects {
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
function carryOnBuilding(task: TaskIn<"build">, workspace: Workspace): Effects {
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
function resend(task: Task): Effects {
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

// ---------------------------------------------------------------------------
// The phases
// ---------------------------------------------------------------------------

function inTriage(task: TaskIn<"triage">, input: Input, ctx: Context): Decision {
  switch (input.type) {
    // The planner starts in the new workspace, read only.
    case "workspace_created": {
      const planner = startPlanner(task, input.workspace, next(task));
      return ctx.accept(
        [{ type: "workspace.created", workspace: input.workspace }, ...planner.events],
        planner.commands,
      );
    }

    // The planner's call. Your overrides win over it, field by field. The
    // planner is stopped, and the builder starts once the stop is confirmed.
    // A spec is committed by Skelcrew meanwhile, since the planner can't edit.
    case "triage_proceed": {
      if (task.question !== null) {
        return ctx.reject(`#${task.id} has an open question. Wait for the answer.`);
      }
      const { override, workspace } = task;
      if (workspace === null) return ctx.reject(`#${task.id} has no workspace.`);
      const plan: Plan = {
        intent: override.intent ?? input.plan.intent,
        rigor: override.rigor ?? input.plan.rigor,
        approve: override.approve ?? input.plan.approve,
        brief: input.plan.brief,
        specPath: null,
      };
      const stop = stopAgent(task, input.session, next(task), false, null);
      if (input.spec === null) {
        return ctx.accept(
          [{ type: "task.triaged", outcome: "proceed", plan, spec: null }, ...stop.events],
          stop.commands,
        );
      }
      const request = next(task) + 1;
      return ctx.accept(
        [
          { type: "task.triaged", outcome: "proceed", plan, spec: { text: input.spec, request } },
          ...stop.events,
        ],
        [
          ...stop.commands,
          { type: "commit_spec", taskId: task.id, request, workspace, text: input.spec },
        ],
      );
    }

    // The task ends here. The planner is stopped, and the workspace and its
    // branch are removed with it, since nothing was built.
    case "triage_split":
    case "triage_decline": {
      if (task.question !== null) {
        return ctx.reject(`#${task.id} has an open question. Wait for the answer.`);
      }
      if (task.workspace === null) return ctx.reject(`#${task.id} has no workspace.`);
      const remove = { path: task.workspace.path, deleteBranch: true };
      const stop = stopAgent(task, input.session, next(task), false, remove);
      const triaged: EventBody =
        input.type === "triage_split"
          ? { type: "task.triaged", outcome: "split", proposals: input.proposals }
          : { type: "task.triaged", outcome: "decline", reason: input.reason };
      return ctx.accept([triaged, ...stop.events], stop.commands);
    }

    // The spec is on the branch. The builder starts now, unless the planner's
    // stop is still on its way.
    case "spec_committed": {
      const { step } = task;
      if (step.kind !== "committing_spec" || step.request !== input.request) {
        return ctx.reject(notWaitingFor(task, input.request));
      }
      const committed: EventBody = { type: "spec.committed", path: input.path };
      if (task.stopping !== null || task.hold !== null || task.workspace === null) {
        return ctx.accept([committed]);
      }
      const plan = { ...step.plan, specPath: input.path };
      const builder = startBuilder(task, task.workspace, plan, null, next(task));
      return ctx.accept([committed, ...builder.events], builder.commands);
    }

    case "spec_failed": {
      const { step } = task;
      if (step.kind !== "committing_spec" || step.request !== input.request) {
        return ctx.reject(notWaitingFor(task, input.request));
      }
      return ctx.accept([held({ kind: "failed", step: "spec", message: input.message })]);
    }

    default:
      return wrongPhase(task, input, ctx);
  }
}

function inBuild(task: TaskIn<"build">, input: Input, ctx: Context): Decision {
  switch (input.type) {
    case "workspace_created": {
      const builder = startBuilder(task, input.workspace, task.plan, task.feedback, next(task));
      return ctx.accept(
        [{ type: "workspace.created", workspace: input.workspace }, ...builder.events],
        builder.commands,
      );
    }

    // The builder hands its work over. It is stopped, saving any uncommitted
    // work, and the task goes on once the stop is confirmed. An `answer`
    // hands over a report instead of a change, and never edits.
    case "done":
    case "done_answer": {
      if (task.question !== null) {
        return ctx.reject(`#${task.id} has an open question. Wait for the answer.`);
      }
      const answer = task.plan.intent === "answer";
      if (answer && input.type === "done") {
        return ctx.reject(`#${task.id} is an answer task. Hand it over with a report.`);
      }
      if (!answer && input.type === "done_answer") {
        return ctx.reject(
          `#${task.id} is a ${task.plan.intent} task. Hand it over with done, not a report.`,
        );
      }
      if (input.type === "done" && input.branch.changedFiles.length === 0) {
        return ctx.reject("The branch has no changes.");
      }
      const handover: Handover =
        input.type === "done"
          ? { kind: "summary", text: input.summary, branch: input.branch }
          : {
              kind: "report",
              text: input.report,
              proposals: input.proposals,
              branch: input.branch,
            };
      const out = handOver(task, input.session, handover);
      return ctx.accept(out.events, out.commands);
    }

    // Main is in the branch. That commit is the one review, approval and
    // delivery all use.
    case "main_merged": {
      if (!waitingForMerge(task, input.request)) {
        return ctx.reject(notWaitingFor(task, input.request));
      }
      // A `try` skips review, so it finishes now.
      if (task.plan.intent === "try" && task.handover !== null) {
        const after = afterVerdict(
          task,
          task.plan,
          input.reviewed,
          task.handover,
          null,
          next(task),
          ctx.config,
        );
        return ctx.accept(
          [{ type: "main.merged", reviewed: input.reviewed }, ...after.events],
          after.commands,
        );
      }
      const copy = startCopy(task, input.reviewed, next(task));
      return ctx.accept(
        [{ type: "main.merged", reviewed: input.reviewed }, ...copy.events],
        copy.commands,
      );
    }

    // The merge is left unfinished, and a fresh builder finishes it. That
    // counts as a loop, and at the cap the task waits for you.
    case "main_conflict": {
      if (!waitingForMerge(task, input.request)) {
        return ctx.reject(notWaitingFor(task, input.request));
      }
      const conflict: EventBody = { type: "main.conflict", files: input.files };
      if (task.loops + 1 >= ctx.config.loopCap) {
        const findings = `Merging main conflicted in ${input.files.join(", ")}.`;
        return ctx.accept([conflict, held({ kind: "loop_cap", findings })]);
      }
      if (task.workspace === null) return ctx.reject(`#${task.id} has no workspace.`);
      const feedback: Feedback = { kind: "conflict", files: input.files };
      const builder = startBuilder(task, task.workspace, task.plan, feedback, next(task));
      return ctx.accept([conflict, ...builder.events], builder.commands);
    }

    case "main_failed":
      if (!waitingForMerge(task, input.request)) {
        return ctx.reject(notWaitingFor(task, input.request));
      }
      return ctx.accept([held({ kind: "failed", step: "merge_main", message: input.message })]);

    default:
      return (
        signOffAndDelivery(task, input, ctx, task.handover, null) ?? wrongPhase(task, input, ctx)
      );
  }
}

function inReview(task: TaskIn<"review">, input: Input, ctx: Context): Decision {
  switch (input.type) {
    // The tester starts in its own copy of the reviewed commit, read only,
    // told what the builder handed over.
    case "copy_created": {
      // A copy of any other commit would review something that isn't
      // delivered. It is removed, and the task waits for you.
      if (input.copy.commit !== task.reviewed.head) {
        const message = `The copy is of ${input.copy.commit}, but the reviewed commit is ${task.reviewed.head}.`;
        return ctx.accept(
          [held({ kind: "failed", step: "workspace", message })],
          [{ type: "remove_workspace", path: input.copy.path, deleteBranch: false }],
        );
      }
      const tester = startTester(task, input.copy, next(task));
      return ctx.accept(
        [{ type: "copy.created", copy: input.copy }, ...tester.events],
        tester.commands,
      );
    }

    // The tester is stopped and its copy removed. The verdict names the
    // commit it covers, which is the one that is delivered.
    case "pass": {
      if (task.question !== null) {
        return ctx.reject(`#${task.id} has an open question. Wait for the answer.`);
      }
      const stop = stopTester(task, input.session, next(task), true);
      const passed: EventBody = {
        type: "review.passed",
        commit: task.reviewed.head,
        evidence: input.evidence,
      };
      const after = afterVerdict(
        task,
        task.plan,
        task.reviewed,
        task.handover,
        input.evidence,
        next(task) + 1,
        ctx.config,
      );
      return ctx.accept(
        [passed, ...stop.events, ...after.events],
        [...stop.commands, ...after.commands],
      );
    }

    // Back to build: a fresh builder starts with the findings once the
    // tester's stop is confirmed. That is a loop, and at the cap the task
    // waits for you.
    case "changes": {
      if (task.question !== null) {
        return ctx.reject(`#${task.id} has an open question. Wait for the answer.`);
      }
      const stop = stopTester(task, input.session, next(task), true);
      const asked: EventBody = { type: "review.changes_requested", findings: input.findings };
      if (task.loops + 1 >= ctx.config.loopCap) {
        return ctx.accept(
          [asked, ...stop.events, held({ kind: "loop_cap", findings: input.findings })],
          stop.commands,
        );
      }
      return ctx.accept([asked, ...stop.events], stop.commands);
    }

    default:
      return (
        signOffAndDelivery(task, input, ctx, task.handover, task.evidence) ??
        wrongPhase(task, input, ctx)
      );
  }
}

// Records what the builder handed over and stops it, saving its work unless
// it is an `answer`, which never edits. The task goes on once the stop is
// confirmed.
function handOver(task: TaskIn<"build">, session: SessionId, handover: Handover): Effects {
  const stop = stopAgent(task, session, next(task), task.plan.intent !== "answer", null);
  return { events: [{ type: "build.done", handover }, ...stop.events], commands: stop.commands };
}

// ---------------------------------------------------------------------------
// Changing intent, rigor or approval
// ---------------------------------------------------------------------------

// `skel set`. Each field takes effect in its own way:
// - During triage, a field wins over the planner's call when it comes.
//   Intent and rigor together end triage, as adding with both skips it.
// - Approval applies at once. Cleared while it waits for you, the task is
//   delivered, unless a critical path still needs your sign-off.
// - Rigor applies from the next phase, since agents read it when they start.
// - A new intent restarts build with a fresh builder, since its permissions
//   change. The branch and its commits stay.
function setPlan(
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
    const plan: Plan = {
      intent,
      rigor,
      approve,
      brief: brief(task.title, task.description),
      specPath: null,
    };
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
// fresh builder starts once that stop is confirmed.
function restartBuild(
  task: Exclude<Task, { phase: "ended" }>,
  plan: Plan,
  before: EventBody[],
  ctx: Context,
): Decision {
  const stop = stopRunning(task, next(task), { workspace: false, copy: true });
  const waitForStop = stop.events.length > 0 || task.stopping !== null;
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

// ---------------------------------------------------------------------------
// Approval and delivery
// ---------------------------------------------------------------------------
//
// The last steps of whichever phase ran last: review, or build for a `try`.

// After review passes, or a `try` merges: your sign-off first when the task
// is flagged or touches a critical path, otherwise delivery.
function afterVerdict(
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
function signOffAndDelivery(
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
      const events: EventBody[] = [{ type: "output.delivered", delivered: input.delivered }];
      const commands: Command[] = [];
      if (task.workspace !== null && !task.unsaved) {
        events.push({ type: "workspace.removed", path: task.workspace.path });
        commands.push({ type: "remove_workspace", path: task.workspace.path, deleteBranch: false });
      }
      return ctx.accept(events, commands);
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

// A report from an agent that isn't the task's current one: the reason, or
// null for one that is, and for anything not from an agent. So a builder
// can't pass its own review, and an old session can't act on new work.
function senderMismatch(task: Task, input: Input): string | null {
  if (input.by !== "agent") return null;
  const current = runningSession(task);
  if (current === null) return `#${task.id} has no agent running.`;
  if (current !== input.session) return `#${task.id}'s agent isn't ${input.session}.`;
  return null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// The changed files that match a critical path, so your sign-off says why it
// is needed. `dot` makes ** match hidden files too, such as src/auth/.env, and
// `windows: false` fixes the separator, so every machine gives one answer.
function criticalFiles(files: string[], critical: string[]): string[] {
  const matchers = critical.map((glob) => picomatch(glob, { dot: true, windows: false }));
  return files.filter((file) => matchers.some((matches) => matches(file)));
}

function wrongPhase(task: Task, input: Input, ctx: Context): Decision {
  return ctx.reject(`#${task.id} is in ${task.phase}, so it can't take ${input.type}.`);
}

function held(hold: Hold): EventBody {
  return { type: "task.held", hold };
}

// Why a delivery doesn't match what was reviewed, or null if it does. It
// must be exactly the reviewed commit, as a report for an `answer` and a
// branch otherwise.
function deliveryMismatch(task: TaskIn<"build" | "review">, delivered: Delivered): string | null {
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

// Whether a step is under way that a pause must wait for: something is being
// made, started, merged or delivered.
function settling(task: Exclude<Task, { phase: "ended" }>): boolean {
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

// Whether the task waits for the workspace, or tester's copy, of this request.
function waitingForWorkspace(task: Task, request: number): boolean {
  if (task.phase === "ended") return false;
  const { step } = task;
  return (
    (step.kind === "creating_workspace" || step.kind === "creating_copy") &&
    step.request === request
  );
}

function waitingForMerge(task: TaskIn<"build">, request: number): boolean {
  return task.step.kind === "merging_main" && task.step.request === request;
}

// The number for the task's next request. The event that records a request
// and the command that sends it both use it. An input that sends two takes
// this one and the one after.
function next(task: Task): number {
  return task.requests + 1;
}

// Why a reply is refused: it answers a request the task isn't waiting on.
function notWaitingFor(task: Task, request: number): string {
  return `This reply answers request ${request}, but #${task.id} isn't waiting on it.`;
}

function brief(title: string, description: string | null): string {
  return description === null ? title : `${title}\n\n${description}`;
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}
