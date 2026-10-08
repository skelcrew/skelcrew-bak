// Zod schemas for stored events, and for commands saved in the outbox until
// they are carried out. Both are read back from SQLite, where anything could
// have happened to them, so each is checked before it is used, and again
// before it is written.
//
// Every schema is annotated with the core's own type, so the typechecker
// fails if the two drift apart, and a check at the bottom fails if an event
// type has no schema. Objects are strict: an unknown field is refused, not
// dropped without a word, since a stored event is kept forever and must read
// back exactly as it was written.

import * as z from "zod";
import { CommitSha, SessionId, TaskId } from "../core/ids";
import type {
  BranchFacts,
  Command,
  Delivered,
  Feedback,
  Handover,
  Hold,
  Plan,
  Question,
  SessionContext,
  SessionUsage,
  Source,
  TaskEvent,
  TesterCopy,
  Workspace,
} from "../core/types";

// ---------------------------------------------------------------------------
// The shapes events carry
// ---------------------------------------------------------------------------

const intent = z.enum(["ship", "try", "answer"]);
const rigor = z.enum(["light", "full"]);

const plan: z.ZodType<Plan> = z.strictObject({
  intent,
  rigor,
  approve: z.boolean(),
  brief: z.string(),
  specPath: z.string().nullable(),
});

const source: z.ZodType<Source> = z.union([
  z.strictObject({ kind: z.literal("local") }),
  z.strictObject({
    kind: z.literal("tracker"),
    plugin: z.string(),
    id: z.string(),
    url: z.string(),
  }),
]);

const workspace: z.ZodType<Workspace> = z.strictObject({ path: z.string(), branch: z.string() });
const copy: z.ZodType<TesterCopy> = z.strictObject({ path: z.string(), commit: CommitSha });
const branchFacts: z.ZodType<BranchFacts> = z.strictObject({
  head: CommitSha,
  changedFiles: z.array(z.string()),
});

const proposal = z.strictObject({ title: z.string(), description: z.string() });

const question: z.ZodType<Question> = z.strictObject({
  session: SessionId,
  text: z.string(),
  options: z.array(z.string()),
  askedAt: z.number(),
});

const hold: z.ZodType<Hold> = z.union([
  z.strictObject({ kind: z.literal("paused") }),
  z.strictObject({
    kind: z.literal("crashed"),
    exitCode: z.number().nullable(),
    lastLine: z.string(),
  }),
  z.strictObject({ kind: z.literal("gave_up"), message: z.string() }),
  z.strictObject({ kind: z.literal("loop_cap"), findings: z.string() }),
  z.strictObject({
    kind: z.literal("failed"),
    step: z.enum(["workspace", "session", "spec", "merge_main", "save", "delivery"]),
    message: z.string(),
  }),
]);

const handover: z.ZodType<Handover> = z.union([
  z.strictObject({ kind: z.literal("summary"), text: z.string(), branch: branchFacts }),
  z.strictObject({
    kind: z.literal("report"),
    text: z.string(),
    proposals: z.array(proposal),
    branch: branchFacts,
  }),
]);

const delivered: z.ZodType<Delivered> = z.union([
  z.strictObject({ kind: z.literal("branch"), commit: CommitSha, ref: z.string() }),
  z.strictObject({ kind: z.literal("report"), path: z.string(), commit: CommitSha }),
]);

const usage: z.ZodType<SessionUsage> = z.strictObject({
  tokens: z.number(),
  cacheReads: z.number(),
  workingMs: z.number(),
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// One event's schema: its own fields, plus the version, task and time every
// event carries.
function event<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({
    v: z.literal(1),
    taskId: TaskId,
    at: z.number(),
    type: z.literal(type),
    ...shape,
  });
}

const request = z.number().int().positive();

const events = [
  event("task.received", {
    title: z.string(),
    description: z.string().nullable(),
    source,
    plan: plan.nullable(),
  }),
  event("task.triaged", {
    outcome: z.literal("proceed"),
    plan,
    spec: z.strictObject({ text: z.string(), request }).nullable(),
  }),
  event("task.triaged", { outcome: z.literal("split"), proposals: z.array(proposal) }),
  event("task.triaged", { outcome: z.literal("decline"), reason: z.string() }),
  event("task.set", {
    intent: intent.nullable(),
    rigor: rigor.nullable(),
    approve: z.boolean().nullable(),
  }),
  event("build.restarted", { plan, waitForStop: z.boolean() }),
  event("review.ready", { reviewed: branchFacts }),
  event("workspace.requested", { request, tester: z.boolean() }),
  event("workspace.created", { workspace }),
  event("copy.created", { copy }),
  event("workspace.removed", { path: z.string() }),
  event("session.requested", { request, role: z.enum(["planner", "builder", "tester"]) }),
  event("session.started", { session: SessionId }),
  event("session.ended", {
    session: SessionId,
    reason: z.enum(["reported", "crashed"]),
    exitCode: z.number().nullable(),
    lastLine: z.string(),
  }),
  event("session.stopping", {
    session: SessionId,
    request,
    saves: z.boolean(),
    removes: z.string().nullable(),
  }),
  event("session.stopped", {
    session: SessionId,
    saved: z.enum(["saved", "nothing_to_save", "save_failed"]),
  }),
  event("question.asked", { question }),
  event("answer.kept", { text: z.string() }),
  event("question.answered", { text: z.string() }),
  event("session.attached", {}),
  event("session.detached", { choice: z.enum(["resume", "hand_over"]) }),
  event("task.held", { hold }),
  event("task.released", {}),
  event("task.started_now", {}),
  event("agent.progress", { session: SessionId, text: z.string() }),
  event("build.done", { handover }),
  event("spec.requested", { request, text: z.string() }),
  event("spec.committed", { path: z.string() }),
  event("main.requested", { request }),
  event("main.merged", { reviewed: branchFacts }),
  event("main.conflict", { files: z.array(z.string()) }),
  event("main.failed", { message: z.string() }),
  event("review.passed", { commit: CommitSha, evidence: z.string() }),
  event("review.changes_requested", { findings: z.string() }),
  event("approval.requested", { criticalFiles: z.array(z.string()) }),
  event("approval.given", { commit: CommitSha }),
  event("approval.denied", { note: z.string() }),
  event("output.requested", { request }),
  event("output.delivered", { delivered }),
  event("output.failed", { message: z.string() }),
  event("proposals.decided", { approved: z.array(z.number()), denied: z.array(z.number()) }),
  event("usage.recorded", { session: SessionId, usage }),
  event("task.killed", {}),
  event("task.failed", { reason: z.string() }),
] as const;

export const taskEvent: z.ZodType<TaskEvent> = z.union(events);

// Fails to compile if an event type has no schema above.
type Covered = z.infer<(typeof events)[number]>["type"];
const everyEventHasASchema: Exclude<TaskEvent["type"], Covered> extends never ? true : false = true;
void everyEventHasASchema;

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

// Checks a value read back from the store, or about to be written to it.
export function parseTaskEvent(value: unknown): Parsed<TaskEvent> {
  const parsed = taskEvent.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, reason: z.prettifyError(parsed.error) };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const feedback: z.ZodType<Feedback> = z.union([
  z.strictObject({ kind: z.literal("findings"), text: z.string() }),
  z.strictObject({ kind: z.literal("conflict"), files: z.array(z.string()) }),
  z.strictObject({ kind: z.literal("denied"), note: z.string() }),
  z.strictObject({ kind: z.literal("held"), hold }),
]);

const sessionContext: z.ZodType<SessionContext> = z.strictObject({
  title: z.string(),
  description: z.string().nullable(),
  plan: plan.nullable(),
  feedback: feedback.nullable(),
  handover: handover.nullable(),
  answer: z.string().nullable(),
});

const removal = z.strictObject({ path: z.string(), deleteBranch: z.boolean() });

const commands = [
  z.strictObject({ type: z.literal("create_workspace"), taskId: TaskId, request }),
  z.strictObject({ type: z.literal("create_copy"), taskId: TaskId, request, commit: CommitSha }),
  z.strictObject({
    type: z.literal("remove_workspace"),
    path: z.string(),
    deleteBranch: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("start_session"),
    taskId: TaskId,
    request,
    role: z.enum(["planner", "builder", "tester"]),
    cwd: z.string(),
    edits: z.boolean(),
    context: sessionContext,
  }),
  z.strictObject({
    type: z.literal("stop_session"),
    taskId: TaskId,
    request: request.nullable(),
    session: SessionId,
    save: z.boolean(),
    remove: removal.nullable(),
  }),
  z.strictObject({ type: z.literal("type_into_session"), session: SessionId, text: z.string() }),
  z.strictObject({
    type: z.literal("commit_spec"),
    taskId: TaskId,
    request,
    workspace,
    text: z.string(),
  }),
  z.strictObject({ type: z.literal("merge_main"), taskId: TaskId, request, workspace }),
  z.strictObject({
    type: z.literal("deliver"),
    taskId: TaskId,
    request,
    intent,
    reviewed: branchFacts,
    handover,
    evidence: z.string().nullable(),
  }),
] as const;

export const command: z.ZodType<Command> = z.union(commands);

// Fails to compile if a command type has no schema above.
type CoveredCommand = z.infer<(typeof commands)[number]>["type"];
const everyCommandHasASchema: Exclude<Command["type"], CoveredCommand> extends never
  ? true
  : false = true;
void everyCommandHasASchema;

// Checks a command read back from the outbox, or about to be saved in it.
export function parseCommand(value: unknown): Parsed<Command> {
  const parsed = command.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, reason: z.prettifyError(parsed.error) };
}
