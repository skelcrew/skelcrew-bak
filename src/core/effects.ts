// Effects: what a decision does to the world, as the events that record it
// and the commands that carry it out. decide builds its decisions from these.
// Each takes the request number to use, so decide picks numbers in one place.

import { runningSession, type TaskIn } from "./task";
import type {
  Command,
  EventBody,
  Feedback,
  Handover,
  Plan,
  Reviewed,
  SessionContext,
  SessionId,
  Task,
  TesterCopy,
  Workspace,
} from "./types";

export type Effects = { events: EventBody[]; commands: Command[] };

// Makes the task's workspace: a worktree on a new branch from main.
export function createWorkspace(task: Task, request: number): Effects {
  return {
    events: [{ type: "workspace.requested", request, tester: false }],
    commands: [{ type: "create_workspace", taskId: task.id, request }],
  };
}

// Brings the branch up to date with main, in the builder's workspace.
export function mergeMain(task: Task, workspace: Workspace, request: number): Effects {
  return {
    events: [{ type: "main.requested", request }],
    commands: [{ type: "merge_main", taskId: task.id, request, workspace }],
  };
}

// Starts the planner in the task's workspace, read only.
export function startPlanner(task: Task, workspace: Workspace, request: number): Effects {
  return {
    events: [{ type: "session.requested", request, role: "planner" }],
    commands: [
      {
        type: "start_session",
        taskId: task.id,
        request,
        role: "planner",
        cwd: workspace.path,
        edits: false,
        context: sessionContext(task, null, null),
      },
    ],
  };
}

// Makes the tester's own copy of the reviewed commit, which starts review.
export function startCopy(task: Task, reviewed: Reviewed, request: number): Effects {
  return {
    events: [{ type: "workspace.requested", request, tester: true }],
    commands: [{ type: "create_copy", taskId: task.id, request, commit: reviewed.head }],
  };
}

// Starts the tester in its own copy of the reviewed commit, read only, told
// what the builder handed over.
export function startTester(task: TaskIn<"review">, copy: TesterCopy, request: number): Effects {
  return {
    events: [{ type: "session.requested", request, role: "tester" }],
    commands: [
      {
        type: "start_session",
        taskId: task.id,
        request,
        role: "tester",
        cwd: copy.path,
        edits: false,
        context: { ...sessionContext(task, task.plan, null), handover: task.handover },
      },
    ],
  };
}

// Starts a builder in the task's workspace, told why it is there. It may
// edit, except on an `answer` task, which never changes code.
export function startBuilder(
  task: Task,
  workspace: Workspace,
  plan: Plan,
  feedback: Feedback | null,
  request: number,
): Effects {
  return {
    events: [{ type: "session.requested", request, role: "builder" }],
    commands: [
      {
        type: "start_session",
        taskId: task.id,
        request,
        role: "builder",
        cwd: workspace.path,
        edits: plan.intent !== "answer",
        context: sessionContext(task, plan, feedback),
      },
    ],
  };
}

// Stops whichever agent is working, if any. A builder that can edit has its
// work saved. A tester's copy is removed with it. `remove` is the workspace
// to remove too, for a planner or builder.
export function stopRunning(
  task: Task,
  request: number,
  remove: { path: string; deleteBranch: boolean } | null,
): Effects {
  const session = runningSession(task);
  if (session === null) return { events: [], commands: [] };
  if (task.phase === "review") return stopTester(task, session, request);
  const save = task.phase === "build" && task.plan.intent !== "answer";
  return stopAgent(task, session, request, save, remove);
}

// Stops the tester and removes its copy. It never edits, so nothing is saved.
export function stopTester(task: TaskIn<"review">, session: SessionId, request: number): Effects {
  const remove = task.copy === null ? null : { path: task.copy.path, deleteBranch: false };
  return stopAgent(task, session, request, false, remove);
}

// Stops an agent the task lets go. With `save`, its uncommitted work is
// committed after it stops. `remove` is a workspace to remove after that,
// unless the save failed. The task keeps its slot until the stop is confirmed.
export function stopAgent(
  task: Task,
  session: SessionId,
  request: number,
  save: boolean,
  remove: { path: string; deleteBranch: boolean } | null,
): Effects {
  return {
    events: [
      { type: "session.stopping", session, request, saves: save, removes: remove?.path ?? null },
    ],
    commands: [{ type: "stop_session", taskId: task.id, request, session, save, remove }],
  };
}

// What a new session is told, on top of its role's preamble.
export function sessionContext(
  task: Task,
  plan: Plan | null,
  feedback: Feedback | null,
): SessionContext {
  return {
    title: task.title,
    description: task.description,
    plan,
    feedback,
    handover: null,
    answer: null,
  };
}

// Hands over exactly the reviewed commit, or the report for an `answer`.
export function deliver(
  task: Task,
  plan: Plan,
  reviewed: Reviewed,
  handover: Handover,
  evidence: string | null,
  request: number,
): Effects {
  return {
    events: [{ type: "output.requested", request }],
    commands: [
      {
        type: "deliver",
        taskId: task.id,
        request,
        intent: plan.intent,
        reviewed,
        handover,
        evidence,
      },
    ],
  };
}
