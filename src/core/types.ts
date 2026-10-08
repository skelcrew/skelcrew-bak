// Core types for Skelcrew. Draft, for review in a live session.
//
// Everything here is plain data. The core never reads the clock, the disk or
// the network: time and IDs arrive inside inputs, and side effects leave as
// commands. docs/core.md describes the model in words, and
// docs/invariants.md the rules it must never break.

import type { CommitSha, SessionId, TaskId } from "./ids";

export type { CommitSha, SessionId, TaskId };

// Passed in, never read with Date.now(). That keeps decide deterministic.
export type Timestamp = number; // milliseconds since epoch

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

export type Intent = "ship" | "try" | "answer";
export type Rigor = "light" | "full";
export type Role = "planner" | "builder" | "tester";

// What triage decides, or what you set when adding a task. The builder starts
// from the brief, and the tester checks against it.
export type Plan = {
  intent: Intent;
  rigor: Rigor;
  approve: boolean;
  brief: string;
  specPath: string | null; // committed to the task's branch by Skelcrew
};

// The task's worktree, on its own branch, such as "skel/142-empty-export".
export type Workspace = { path: string; branch: string };

// The tester's detached copy. Writable, but thrown away after the verdict.
export type TesterCopy = { path: string; commit: CommitSha };

// What the branch holds when work is handed over. The daemon reads it from
// git. The agent never supplies it. `changedFiles` is every file the branch
// changed since it left main, not only its last commit, so a critical file
// changed early can't hide.
export type BranchFacts = { head: CommitSha; changedFiles: string[] };

// The one commit that review, approval and delivery all use: the handed-over
// work with main merged in, or the handed-over commit for `answer`.
export type Reviewed = BranchFacts;

// Options make an answer one tap. The session that asked is kept, so the
// question goes when that agent goes.
export type Question = {
  session: SessionId;
  text: string;
  options: string[]; // two to four; free text is always allowed
  askedAt: Timestamp;
};

// Your answer, kept until a slot is free. The question stays open until it
// reaches the agent, so a second answer is refused.
export type KeptAnswer = { text: string; keptAt: Timestamp };

// A task proposed by a split or an answer. It becomes a task only when you
// approve it.
export type Proposal = {
  title: string;
  description: string;
  decision: "pending" | "approved" | "denied";
};

// What the next builder is told when it starts: why it is back.
export type Feedback =
  | { kind: "findings"; text: string } // the tester asked for changes
  | { kind: "conflict"; files: string[] } // merging main conflicted
  | { kind: "denied"; note: string } // you denied the sign-off
  | { kind: "held"; hold: Hold }; // why the last builder was stopped

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

// A held task has no agent at work, and never starts again without you.
// Skelcrew never retries on its own: anything that goes wrong holds the task
// with what happened, and `skel retry` lifts it.
export type Hold =
  | { kind: "paused" }
  | { kind: "crashed"; exitCode: number | null; lastLine: string }
  | { kind: "gave_up"; message: string }
  | { kind: "loop_cap"; findings: string }
  | {
      kind: "failed";
      step: "workspace" | "session" | "spec" | "merge_main" | "save" | "delivery";
      message: string;
    };

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
//
// A step that waits on a reply holds its request number. The reply must bring
// it back, so a late or repeated reply can never answer the current request.

// Waits for the agent before it to stop. The task keeps its slot meanwhile,
// and the next agent starts once the stop is confirmed.
type AwaitingStop = { kind: "awaiting_stop" };

export type TriageStep =
  | { kind: "queued" }
  | { kind: "creating_workspace"; request: number }
  | { kind: "starting"; request: number }
  | { kind: "running"; session: SessionId }
  // The planner proceeded with a spec, and Skelcrew is committing it to the
  // branch. The planner can't, since it has no edit permission.
  // A null request means it failed, and nothing is sent until your retry.
  | { kind: "committing_spec"; request: number | null; plan: Plan; text: string };

export type BuildStep =
  | { kind: "queued" }
  | AwaitingStop
  | { kind: "creating_workspace"; request: number } // only when triage was skipped
  | { kind: "starting"; request: number }
  | { kind: "running"; session: SessionId }
  // The builder has been stopped. A fresh one starts if review asks for changes.
  | { kind: "merging_main"; request: number | null } // null after a failure
  | Finishing; // only for `try`, which skips review

export type ReviewStep =
  | { kind: "queued" } // after a hold
  | { kind: "creating_copy"; request: number }
  | { kind: "starting"; request: number }
  | { kind: "running"; session: SessionId }
  | Finishing;

// The last steps of whichever phase ran last. No agent runs in either.
export type Finishing =
  | { kind: "awaiting_approval" }
  | { kind: "delivering"; request: number | null }; // null after a failure

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------
//
// Each phase carries only the data it needs, so impossible states can't be
// written down. A move to another phase is built from the base fields plus
// the new phase's own, never by spreading the old phase.

export type PhaseState =
  | {
      phase: "triage";
      workspace: Workspace | null;
      step: TriageStep;
      // What you set while the planner works. It wins over the planner's
      // call for that field.
      override: { intent: Intent | null; rigor: Rigor | null; approve: boolean | null };
    }
  | {
      phase: "build";
      plan: Plan;
      workspace: Workspace | null; // null only while it is being created
      step: BuildStep;
      loops: number;
      feedback: Feedback | null;
      handover: Handover | null; // set at `done`
      reviewed: Reviewed | null; // set once main is merged, for `try`
    }
  | {
      phase: "review";
      plan: Plan;
      workspace: Workspace;
      step: ReviewStep;
      loops: number;
      handover: Handover;
      reviewed: Reviewed;
      // On the phase, not the step, so it stays tracked until it is removed,
      // even after the verdict.
      copy: TesterCopy | null;
      evidence: string | null; // set when review passes
    }
  | {
      phase: "ended";
      outcome: Outcome;
      proposals: Proposal[];
      // The workspace until its removal is confirmed. One whose work couldn't
      // be saved is never removed, and stays here.
      kept: Workspace | null;
    };

// What the builder handed over: a summary of the change, or for `answer` a
// report and any tasks it proposes. Kept until delivery, so a restart loses
// nothing.
export type Handover = { branch: BranchFacts } & (
  | { kind: "summary"; text: string }
  | { kind: "report"; text: string; proposals: { title: string; description: string }[] }
);

export type Outcome =
  | { kind: "done"; delivered: Delivered }
  | { kind: "split" }
  | { kind: "declined"; reason: string }
  | { kind: "killed" }
  | { kind: "failed"; reason: string };

// What was handed over: exactly the reviewed commit, or a report.
export type Delivered =
  | { kind: "branch"; commit: CommitSha; ref: string } // `try`, and `ship` in the MVP
  | { kind: "report"; path: string; commit: CommitSha }; // `answer`

// Where a task came from. The task keeps its own number either way.
export type Source =
  | { kind: "local" }
  | { kind: "tracker"; plugin: string; id: string; url: string };

// Running totals per session. A fresh session starts at zero, so totals are
// kept per session and summed for the task. Cache reads are counted on their
// own, since they would swamp the rest. Usage is shown, never enforced.
export type SessionUsage = { tokens: number; cacheReads: number; workingMs: number };

export type Task = PhaseState & TaskBase;

// The fields every task has, whatever its phase. A move to another phase is
// built from these plus the new phase's own.
export type TaskBase = {
  id: TaskId;
  source: Source;
  title: string;
  description: string | null;
  createdAt: Timestamp;
  question: Question | null;
  keptAnswer: KeptAnswer | null;
  hold: Hold | null;
  attached: boolean;
  // Where the task waits in the scheduler's order. Kept answers go first,
  // then resumed tasks, then the rest. `skel start` skips the queue.
  lane: "resumed" | "queued";
  // An agent being stopped. The task keeps its slot until the stop is
  // confirmed, and nothing new starts on the task before then.
  // `removes` is the path its stop removes once the work is safe, if any.
  stopping: { session: SessionId; request: number; removes: string | null } | null;
  // How many requests the task has sent that expect a reply. An event that
  // sends one carries its number, and evolve records it from there.
  requests: number;
  usage: Partial<Record<SessionId, SessionUsage>>;
};

// ---------------------------------------------------------------------------
// Inputs, typed by sender
// ---------------------------------------------------------------------------
//
// The boundary that receives a call sets `by`, never the caller. An agent's
// call can only become an AgentInput, so an agent has no way to express
// "approve this".

export type YourInput =
  | { type: "add"; title: string; description: string | null; plan: AddPlan | null }
  | { type: "set"; intent: Intent | null; rigor: Rigor | null; approve: boolean | null }
  | { type: "reply"; text: string } // also from the tracker, from your accounts only
  | { type: "approve" }
  | { type: "deny"; note: string }
  | { type: "decide_proposals"; approved: number[]; denied: number[] } // by index
  | { type: "attach" }
  | { type: "detach"; choice: "resume" }
  // The daemon attaches `branch` from git, as it does for an agent's done.
  | { type: "detach"; choice: "hand_over"; branch: BranchFacts }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "start_now" } // even past max_running
  | { type: "retry" }
  | { type: "kill" };

// Intent and rigor given when adding a task, which skips triage.
export type AddPlan = { intent: Intent; rigor: Rigor; approve: boolean };

// Each one names its session. Only the session the task's step holds is
// heard, and only for its own role.
export type AgentInput = { session: SessionId } & (
  | { type: "triage_proceed"; plan: Omit<Plan, "specPath">; spec: string | null }
  | { type: "triage_split"; proposals: { title: string; description: string }[] }
  | { type: "triage_decline"; reason: string }
  | { type: "ask"; text: string; options: string[] }
  | { type: "progress"; text: string }
  // The daemon attaches `branch` from git before the input reaches the core.
  | { type: "done"; summary: string; branch: BranchFacts }
  | {
      type: "done_answer";
      report: string;
      proposals: { title: string; description: string }[];
      branch: BranchFacts;
    }
  | { type: "give_up"; message: string }
  | { type: "pass"; evidence: string }
  | { type: "changes"; findings: string }
);

// Results of commands the core sent, and signals from outside. Every reply
// brings back its request number.
export type PluginInput =
  | {
      type: "task_received";
      title: string;
      description: string | null;
      source: Source;
      plan: AddPlan | null;
    }
  | { type: "outside_change"; what: string } // always refused
  | { type: "workspace_created"; request: number; workspace: Workspace }
  | { type: "copy_created"; request: number; copy: TesterCopy }
  | { type: "workspace_failed"; request: number; message: string }
  | { type: "session_started"; request: number; session: SessionId }
  | { type: "session_failed"; request: number; message: string }
  // Names the request that started it, so an end that overtakes the start
  // reply still counts.
  | {
      type: "session_ended";
      request: number;
      session: SessionId;
      exitCode: number | null;
      lastLine: string;
    }
  | {
      type: "stopped";
      request: number;
      session: SessionId;
      saved: "saved" | "nothing_to_save" | "save_failed";
      message: string;
    }
  | { type: "spec_committed"; request: number; path: string }
  | { type: "spec_failed"; request: number; message: string }
  | { type: "main_merged"; request: number; reviewed: Reviewed }
  | { type: "main_conflict"; request: number; files: string[] }
  | { type: "main_failed"; request: number; message: string }
  | { type: "delivered"; request: number; delivered: Delivered }
  | { type: "delivery_failed"; request: number; message: string };

// Inputs the daemon makes itself. The scheduler's pick is an input, so decide
// keeps the final say.
export type DaemonInput =
  | { type: "start" }
  | { type: "deliver_answer" }
  | { type: "usage"; session: SessionId; usage: SessionUsage };

export type Input =
  | ({ by: "you" } & YourInput)
  | ({ by: "agent" } & AgentInput)
  | ({ by: "plugin" } & PluginInput)
  | ({ by: "daemon" } & DaemonInput);

// The time rides along with every input. For an input that creates a task,
// taskId is the new task's number, picked by the daemon.
export type Envelope = { taskId: TaskId; at: Timestamp; input: Input };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
//
// Events are the source of truth: a task is rebuilt by folding its events
// through evolve. An event must say everything needed to rebuild state.
// Every event that sends a request carries its number.

export type EventBody =
  | {
      type: "task.received";
      title: string;
      description: string | null;
      source: Source;
      // Set when you gave intent and rigor, so triage is skipped. decide
      // writes the brief here, so evolve only applies it.
      plan: Plan | null;
    }
  // With a spec, Skelcrew commits it to the branch as `request`.
  | {
      type: "task.triaged";
      outcome: "proceed";
      plan: Plan;
      spec: { text: string; request: number } | null;
    }
  | {
      type: "task.triaged";
      outcome: "split";
      proposals: { title: string; description: string }[];
    }
  | { type: "task.triaged"; outcome: "decline"; reason: string }
  | { type: "task.set"; intent: Intent | null; rigor: Rigor | null; approve: boolean | null }
  // Build starts over with this plan: when you change intent, or when your
  // intent and rigor end triage. It waits for an agent's stop first, if one
  // is stopping.
  | { type: "build.restarted"; plan: Plan; waitForStop: boolean }
  // An `answer` merges nothing, so its handed-over commit goes to review as is.
  | { type: "review.ready"; reviewed: Reviewed }
  | { type: "workspace.requested"; request: number; tester: boolean }
  | { type: "workspace.created"; workspace: Workspace }
  | { type: "copy.created"; copy: TesterCopy }
  | { type: "workspace.removed"; path: string }
  | { type: "session.requested"; request: number; role: Role }
  | { type: "session.started"; session: SessionId }
  | {
      type: "session.ended";
      session: SessionId;
      reason: "reported" | "crashed";
      exitCode: number | null;
      lastLine: string;
    }
  | { type: "session.stopping"; session: SessionId; request: number; removes: string | null }
  | {
      type: "session.stopped";
      session: SessionId;
      saved: "saved" | "nothing_to_save" | "save_failed";
    }
  | { type: "question.asked"; question: Question }
  | { type: "answer.kept"; text: string }
  | { type: "question.answered"; text: string }
  | { type: "session.attached" }
  | { type: "session.detached"; choice: "resume" | "hand_over" }
  | { type: "task.held"; hold: Hold }
  | { type: "task.released" } // your resume or retry lifts the hold
  | { type: "task.started_now" }
  | { type: "agent.progress"; session: SessionId; text: string }
  | { type: "build.done"; handover: Handover }
  | { type: "spec.requested"; request: number; text: string }
  | { type: "spec.committed"; path: string }
  | { type: "main.requested"; request: number }
  | { type: "main.merged"; reviewed: Reviewed }
  | { type: "main.conflict"; files: string[] }
  | { type: "main.failed"; message: string }
  | { type: "review.passed"; commit: CommitSha; evidence: string }
  | { type: "review.changes_requested"; findings: string }
  | { type: "approval.requested"; criticalFiles: string[] }
  | { type: "approval.given"; commit: CommitSha }
  | { type: "approval.denied"; note: string }
  | { type: "output.requested"; request: number }
  | { type: "output.delivered"; delivered: Delivered }
  | { type: "output.failed"; message: string }
  | { type: "proposals.decided"; approved: number[]; denied: number[] }
  | { type: "usage.recorded"; session: SessionId; usage: SessionUsage }
  | { type: "task.killed" }
  | { type: "task.failed"; reason: string };

export type TaskEvent = EventBody & {
  // The log is kept forever, so old events must stay readable after their
  // shape changes. The version says which shape an event was written in.
  v: 1;
  taskId: TaskId;
  at: Timestamp;
};

// ---------------------------------------------------------------------------
// Commands: work the daemon does. Results come back as inputs.
// ---------------------------------------------------------------------------

export type Command =
  | { type: "create_workspace"; taskId: TaskId; request: number }
  | { type: "create_copy"; taskId: TaskId; request: number; commit: CommitSha }
  | { type: "remove_workspace"; path: string; deleteBranch: boolean }
  | {
      type: "start_session";
      taskId: TaskId;
      request: number;
      role: Role;
      cwd: string;
      edits: boolean; // never true on an `answer` task
      context: SessionContext;
    }
  // The daemon stops the session, then commits any uncommitted work when
  // `save` is set. Then it removes `remove`, unless the save failed, so work
  // is never thrown away.
  | {
      type: "stop_session";
      taskId: TaskId;
      // Null for the cleanup of a late session, whose stop nobody waits on.
      request: number | null;
      session: SessionId;
      save: boolean;
      remove: { path: string; deleteBranch: boolean } | null;
    }
  // Sent at most once: recorded before it is typed, never repeated.
  | { type: "type_into_session"; session: SessionId; text: string }
  | {
      type: "commit_spec";
      taskId: TaskId;
      request: number;
      workspace: Workspace;
      text: string;
    }
  | { type: "merge_main"; taskId: TaskId; request: number; workspace: Workspace }
  | {
      type: "deliver";
      taskId: TaskId;
      request: number;
      intent: Intent;
      reviewed: Reviewed;
      handover: Handover;
      evidence: string | null;
    };

// What a new session is told, on top of the role's preamble and your
// instructions from config.
export type SessionContext = {
  title: string;
  description: string | null;
  plan: Plan | null; // null for the planner
  feedback: Feedback | null;
  handover: Handover | null; // what the tester reviews
  answer: string | null; // your answer, when the session is new
};

// ---------------------------------------------------------------------------
// Config: the parts of skelcrew.yaml the core reads
// ---------------------------------------------------------------------------

export type Config = {
  maxRunning: number;
  loopCap: number; // build and review round trips, 3
  critical: string[]; // globs; a match needs your sign-off
};

// ---------------------------------------------------------------------------
// The core functions
// ---------------------------------------------------------------------------

export type Rejection = { input: Input["type"]; reason: string };

// Accepted with events and commands, or rejected and nothing changes. A late
// reply is accepted with only the commands that clean up after it.
export type Decision =
  | { ok: true; events: TaskEvent[]; commands: Command[] }
  | { ok: false; rejection: Rejection };

export type Decide = (task: Task | null, envelope: Envelope, config: Config) => Decision;

// Replay runs evolve alone, so old events are never judged by rules that have
// changed since. An event that doesn't fit is refused with the reason, so a
// damaged log stops replay instead of rebuilding a wrong task.
export type Evolve = (task: Task | null, event: TaskEvent) => Evolved;
export type Evolved = { ok: true; task: Task } | { ok: false; reason: string };

// Picks which tasks get a free slot: kept answers, then resumed tasks, then queued ones, oldest first within each. Only
// proposes: each pick becomes a "start" or "deliver_answer" input.
// `inFlight` is the starts and stops the loop has sent and not yet seen
// answered, since a task can't keep a marker once it has ended.
export type Schedule = (tasks: Task[], config: Config, inFlight: number) => TaskId[];
