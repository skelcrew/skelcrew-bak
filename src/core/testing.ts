// What the core's tests share: a config, IDs, and a way to drive a task
// through real inputs, so every test starts from a state the real code can
// reach.

import { decide } from "./decide";
import { evolve } from "./evolve";
import { CommitSha, SessionId, TaskId } from "./ids";
import type {
  Command,
  Config,
  Decision,
  Input,
  Intent,
  Rigor,
  Task,
  TaskEvent,
  TesterCopy,
  Workspace,
} from "./types";

export const config: Config = { maxRunning: 2, loopCap: 3, critical: ["src/auth/**"] };
export const id = TaskId.parse(142);

export const planner = SessionId.parse("session-planner");
export const builder = SessionId.parse("session-builder");
export const tester = SessionId.parse("session-tester");

export const sha = (letter: string): CommitSha => CommitSha.parse(letter.repeat(40));

export const workspace: Workspace = {
  path: "/repo/.skelcrew/worktrees/142-fix-empty-export",
  branch: "skel/142-fix-empty-export",
};

// The tester's copy of the reviewed commit, defined below with it.
export const copyPath = "/repo/.skelcrew/review/142";

export type Run = { task: Task; events: TaskEvent[]; commands: Command[] };

// Sends each input through decide, and folds the accepted events through
// evolve, as the loop does. Fails the test on the first rejection. Returns the
// task, and the events and commands of the last input.
export function play(from: Task | null, inputs: Input[], cfg: Config = config): Run {
  let task = from;
  let events: TaskEvent[] = [];
  let commands: Command[] = [];
  for (const [i, input] of inputs.entries()) {
    const decision = decide(task, { taskId: id, at: 1_000 + i, input }, cfg);
    if (!decision.ok) throw new Error(`Rejected ${input.type}: ${decision.rejection.reason}`);
    for (const event of decision.events) {
      const evolved = evolve(task, event);
      if (!evolved.ok) throw new Error(evolved.reason);
      task = evolved.task;
    }
    events = decision.events;
    commands = decision.commands;
  }
  if (task === null) throw new Error("No task was created.");
  return { task, events, commands };
}

export function run(...inputs: Input[]): Run {
  return play(null, inputs);
}

// What decide says to one more input, without applying it.
export function next(task: Task | null, input: Input, cfg: Config = config): Decision {
  return decide(task, { taskId: id, at: 9_000, input }, cfg);
}

export function types(events: TaskEvent[]): string[] {
  return events.map((event) => event.type);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const add = (title = "Fix empty export", description: string | null = null): Input => ({
  by: "you",
  type: "add",
  title,
  description,
  plan: null,
});

export const start: Input = { by: "daemon", type: "start" };

export const workspaceCreated = (request: number): Input => ({
  by: "plugin",
  type: "workspace_created",
  request,
  workspace,
});

export const workspaceFailed = (request: number, message = "disk full"): Input => ({
  by: "plugin",
  type: "workspace_failed",
  request,
  message,
});

export const sessionStarted = (request: number, session: SessionId): Input => ({
  by: "plugin",
  type: "session_started",
  request,
  session,
});

export const sessionFailed = (request: number, message = "claude not found"): Input => ({
  by: "plugin",
  type: "session_failed",
  request,
  message,
});

export const sessionEnded = (
  request: number,
  session: SessionId,
  exitCode: number | null = 1,
  lastLine = "Segmentation fault",
): Input => ({ by: "plugin", type: "session_ended", request, session, exitCode, lastLine });

// A task in triage whose planner is running, as request 2.
export function triageRunning(): Run {
  return run(add(), start, workspaceCreated(1), sessionStarted(2, planner));
}

export const ask = (session: SessionId, text = "Include archived rows?"): Input => ({
  by: "agent",
  session,
  type: "ask",
  text,
  options: ["Yes", "No"],
});

export const reply = (text = "No"): Input => ({ by: "you", type: "reply", text });

export const deliverAnswer: Input = { by: "daemon", type: "deliver_answer" };

export type Saved = "saved" | "nothing_to_save" | "save_failed";

export const stopped = (
  request: number,
  session: SessionId,
  saved: Saved = "nothing_to_save",
): Input => ({ by: "plugin", type: "stopped", request, session, saved, message: "" });

export const proceed = (
  spec: string | null = null,
  plan: { intent: Intent; rigor: Rigor; approve: boolean } = {
    intent: "ship",
    rigor: "full",
    approve: false,
  },
): Input => ({
  by: "agent",
  session: planner,
  type: "triage_proceed",
  plan: { ...plan, brief: "Empty reports crash. Look in the CSV writer." },
  spec,
});

export const specCommitted = (request: number, path = "docs/plans/142-fix.md"): Input => ({
  by: "plugin",
  type: "spec_committed",
  request,
  path,
});

// A task whose builder is running, as request 4, after a planner proceeded.
export function buildRunning(
  plan: { intent: Intent; rigor: Rigor; approve: boolean } = {
    intent: "ship",
    rigor: "full",
    approve: false,
  },
): Run {
  return play(triageRunning().task, [
    proceed(null, plan),
    stopped(3, planner),
    sessionStarted(4, builder),
  ]);
}

export const branch = { head: sha("a"), changedFiles: ["src/export/csv.ts"] };

export const done = (
  summary = "Empty reports now export a header row.",
  facts: { head: CommitSha; changedFiles: string[] } = branch,
): Input => ({ by: "agent", session: builder, type: "done", summary, branch: facts });

export const doneAnswer = (report = "Search is slow because of N+1 queries."): Input => ({
  by: "agent",
  session: builder,
  type: "done_answer",
  report,
  proposals: [],
  branch,
});

export const reviewed = { head: sha("c"), changedFiles: ["src/export/csv.ts"] };

export const copy: TesterCopy = { path: copyPath, commit: reviewed.head };

export const mainMerged = (request: number, facts = reviewed): Input => ({
  by: "plugin",
  type: "main_merged",
  request,
  reviewed: facts,
});

export const mainConflict = (request: number, files = ["src/export/csv.ts"]): Input => ({
  by: "plugin",
  type: "main_conflict",
  request,
  files,
});

export const mainFailed = (request: number, message = "index.lock exists"): Input => ({
  by: "plugin",
  type: "main_failed",
  request,
  message,
});

// A task you added with intent and rigor, skipping triage.
export const addPlanned = (
  intent: Intent = "ship",
  rigor: Rigor = "light",
  approve = false,
): Input => ({
  by: "you",
  type: "add",
  title: "Fix button color",
  description: null,
  plan: { intent, rigor, approve },
});

// The copy is of the reviewed commit unless told otherwise, such as an
// answer's handed-over commit.
export const copyCreated = (request: number, commit = reviewed.head): Input => ({
  by: "plugin",
  type: "copy_created",
  request,
  copy: { path: copyPath, commit },
});

export const pass = (evidence = "bun test: 212 pass"): Input => ({
  by: "agent",
  session: tester,
  type: "pass",
  evidence,
});

export const changes = (findings = "The header row is missing its last column."): Input => ({
  by: "agent",
  session: tester,
  type: "changes",
  findings,
});

export const approve: Input = { by: "you", type: "approve" };
export const deny = (note = "Use the existing CSV helper."): Input => ({
  by: "you",
  type: "deny",
  note,
});

export const delivered = (request: number, commit = reviewed.head): Input => ({
  by: "plugin",
  type: "delivered",
  request,
  delivered: { kind: "branch", commit, ref: "skel/142-fix-empty-export" },
});

export const deliveredReport = (request: number, commit = branch.head): Input => ({
  by: "plugin",
  type: "delivered",
  request,
  delivered: { kind: "report", path: "docs/answers/142.md", commit },
});

export const deliveryFailed = (request: number, message = "branch is checked out"): Input => ({
  by: "plugin",
  type: "delivery_failed",
  request,
  message,
});

// A task whose tester is running, as request 8, on the reviewed commit.
export function reviewRunning(
  plan: { intent: Intent; rigor: Rigor; approve: boolean } = {
    intent: "ship",
    rigor: "full",
    approve: false,
  },
  facts = reviewed,
): Run {
  return play(buildRunning(plan).task, [
    done(),
    stopped(5, builder, "saved"),
    mainMerged(6, facts),
    copyCreated(7),
    sessionStarted(8, tester),
  ]);
}

export const pause: Input = { by: "you", type: "pause" };
export const resume: Input = { by: "you", type: "resume" };
export const retry: Input = { by: "you", type: "retry" };
export const kill: Input = { by: "you", type: "kill" };
export const startNow: Input = { by: "you", type: "start_now" };

export const usage = (
  session: SessionId,
  tokens: number,
  workingMs = 60_000,
  cacheReads = 0,
): Input => ({ by: "daemon", type: "usage", session, usage: { tokens, cacheReads, workingMs } });

export const set = (fields: { intent?: Intent; rigor?: Rigor; approve?: boolean }): Input => ({
  by: "you",
  type: "set",
  intent: fields.intent ?? null,
  rigor: fields.rigor ?? null,
  approve: fields.approve ?? null,
});

export const attach: Input = { by: "you", type: "attach" };
