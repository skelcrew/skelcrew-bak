// The protocol between `skel` and the daemon: one JSON message per line, over
// the daemon's local socket. `skel` sends a request, and the daemon answers
// it with an answer carrying the same id.
//
// Everything read from the socket is checked here before anything acts on it.
// Objects are strict, so a field with a typo is refused rather than ignored.
// Messages carry the protocol's version, so a `skel` and a daemon from
// different versions say so instead of misreading each other.

import * as z from "zod";
import { TaskId } from "../core/ids";
import type { AgentInput, Task, YourInput } from "../core/types";
import { intent, proposal, rigor } from "../store/schema";

export const VERSION = 1;

// Longer lines are refused, so a client that never ends its line can't make
// the daemon read without end.
export const MAX_LINE = 1_000_000;

// ---------------------------------------------------------------------------
// What you and agents send
// ---------------------------------------------------------------------------

const input = z.discriminatedUnion("type", [
  // Your inputs, as the core takes them. Attaching and detaching need a real
  // session, so they come with milestone 4.
  z.strictObject({
    type: z.literal("add"),
    title: z.string().min(1),
    description: z.string().nullable(),
    plan: z.strictObject({ intent, rigor, approve: z.boolean() }).nullable(),
  }),
  z.strictObject({
    type: z.literal("set"),
    intent: intent.nullable(),
    rigor: rigor.nullable(),
    approve: z.boolean().nullable(),
  }),
  z.strictObject({ type: z.literal("reply"), text: z.string().min(1) }),
  z.strictObject({ type: z.literal("approve") }),
  z.strictObject({ type: z.literal("deny"), note: z.string().min(1) }),
  z.strictObject({
    type: z.literal("decide_proposals"),
    approved: z.array(z.int().nonnegative()),
    denied: z.array(z.int().nonnegative()),
  }),
  z.strictObject({ type: z.literal("pause") }),
  z.strictObject({ type: z.literal("resume") }),
  z.strictObject({ type: z.literal("start_now") }),
  z.strictObject({ type: z.literal("retry") }),
  z.strictObject({ type: z.literal("kill") }),

  // An agent's inputs, as the core takes them but without what the daemon
  // adds: the session, known from the caller's token, and the branch, read
  // from git.
  z.strictObject({
    type: z.literal("triage_proceed"),
    plan: z.strictObject({ intent, rigor, approve: z.boolean(), brief: z.string() }),
    spec: z.string().nullable(),
  }),
  z.strictObject({ type: z.literal("triage_split"), proposals: z.array(proposal) }),
  z.strictObject({ type: z.literal("triage_decline"), reason: z.string().min(1) }),
  z.strictObject({ type: z.literal("ask"), text: z.string().min(1), options: z.array(z.string()) }),
  z.strictObject({ type: z.literal("progress"), text: z.string().min(1) }),
  z.strictObject({ type: z.literal("done"), summary: z.string() }),
  z.strictObject({
    type: z.literal("done_answer"),
    report: z.string(),
    proposals: z.array(proposal),
  }),
  z.strictObject({ type: z.literal("give_up"), message: z.string().min(1) }),
  z.strictObject({ type: z.literal("pass"), evidence: z.string() }),
  z.strictObject({ type: z.literal("changes"), findings: z.string() }),
]);
export type WireInput = z.infer<typeof input>;

// Every input of yours but attach and detach, and every agent input, has a
// shape here. A new input in the core fails to compile until it gets one.
type Sent = WireInput["type"];
type Later = "attach" | "detach";
const everyInputIsSent: Exclude<
  Exclude<YourInput["type"], Later> | AgentInput["type"],
  Sent
> extends never
  ? true
  : false = true;
void everyInputIsSent;

// `send` is one input for one task. The task is null only when adding one,
// and for an agent, whose task is known from its token.
const call = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("send"), task: TaskId.nullable(), input }),
  z.strictObject({ type: z.literal("ls") }),
]);

// `token` is the caller's session token, from SKELCREW_SESSION. None means
// you.
const request = z.strictObject({
  v: z.literal(VERSION),
  id: z.string().min(1),
  token: z.string().min(1).nullable(),
  call,
});

// ---------------------------------------------------------------------------
// What the daemon answers
// ---------------------------------------------------------------------------

const phase = z.enum(["triage", "build", "review", "ended"] satisfies Task["phase"][]);

// One line of `skel ls`. `state` is the task's step in plain words.
const row = z.strictObject({
  task: TaskId,
  title: z.string(),
  phase,
  intent: intent.nullable(),
  rigor: rigor.nullable(),
  state: z.string(),
});

const result = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("sent"), task: TaskId }),
  z.strictObject({ kind: z.literal("tasks"), tasks: z.array(row) }),
]);

const answer = z.union([
  z.strictObject({ v: z.literal(VERSION), id: z.string().min(1), ok: z.literal(true), result }),
  z.strictObject({
    v: z.literal(VERSION),
    id: z.string().min(1),
    ok: z.literal(false),
    message: z.string(),
  }),
]);

export type Request = z.infer<typeof request>;
export type Call = Request["call"];
export type Row = z.infer<typeof row>;
export type Result = z.infer<typeof result>;
export type Answer = z.infer<typeof answer>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

export function parseRequest(line: string): Parsed<Request> {
  return parseLine(line, request, "request");
}

export function parseAnswer(line: string): Parsed<Answer> {
  return parseLine(line, answer, "answer");
}

// One message as one line, ending in a newline. JSON never holds a raw
// newline, so a line is always one whole message.
export function encode(message: Request | Answer): string {
  return `${JSON.stringify(message)}\n`;
}

function parseLine<T>(line: string, schema: z.ZodType<T>, what: string): Parsed<T> {
  if (Buffer.byteLength(line) > MAX_LINE) {
    return { ok: false, message: `The ${what} is longer than ${MAX_LINE} bytes.` };
  }
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return { ok: false, message: `The ${what} isn't valid JSON.` };
  }
  const version = z.object({ v: z.number() }).safeParse(data);
  if (version.success && version.data.v !== VERSION) {
    const restart = "Restart the daemon with `skel serve` after updating.";
    return {
      ok: false,
      message: `The daemon speaks protocol ${VERSION}, and this ${what} is ${version.data.v}. ${restart}`,
    };
  }
  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, value: parsed.data };
  const reasons = parsed.error.issues.map(
    (issue) => `${issue.path.join(".") || what}: ${issue.message}`,
  );
  return { ok: false, message: `The ${what} doesn't fit the protocol. ${reasons.join("; ")}` };
}
