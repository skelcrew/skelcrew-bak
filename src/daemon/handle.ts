// What the daemon does with one request: turns it into an input for the loop,
// or reads the tasks for `skel ls`, and says what came of it.

import { TaskId } from "../core/ids";
import type { AgentInput, Hold, Task, YourInput } from "../core/types";
import type { Loop } from "../loop/loop";
import {
  type Answer,
  type Call,
  parseRequest,
  type Result,
  type Row,
  VERSION,
  type WireInput,
} from "../protocol/protocol";
import { refusal } from "./server";
import type { Tokens } from "./tokens";

type Handled = { ok: true; result: Result } | { ok: false; message: string };

// One line in, one line out. A line that can't be read is refused, and the
// daemon carries on.
export function answerLine(loop: Loop, tokens: Tokens, line: string): string {
  const parsed = parseRequest(line);
  if (!parsed.ok) return refusal(parsed.message);
  const { id, token, call } = parsed.value;
  const handled = handle(loop, tokens, call, token);
  const answer: Answer = handled.ok
    ? { v: VERSION, id, ok: true, result: handled.result }
    : { v: VERSION, id, ok: false, message: handled.message };
  return `${JSON.stringify(answer)}\n`;
}

// A call with a token comes from that token's session, and goes to the task
// the session works on. One without comes from you. Which inputs each may
// send is checked here, and the core refuses anything outside the session's
// role and phase.
export function handle(loop: Loop, tokens: Tokens, call: Call, token: string | null): Handled {
  if (call.type === "ls") return { ok: true, result: { kind: "tasks", tasks: rows(loop) } };
  if (token !== null) return fromAgent(loop, tokens, call.input, token);

  const input = yours(call.input);
  if (input === null) {
    const message = `\`${call.input.type}\` is an agent's command. It needs the session's token in SKELCREW_SESSION.`;
    return { ok: false, message };
  }

  // A new task gets the next number. Every other input names its task.
  const taskId = input.type === "add" ? nextId(loop) : call.task;
  if (taskId === null) return { ok: false, message: "Say which task." };
  const decision = loop.send(taskId, { by: "you", ...input });
  if (!decision.ok) return { ok: false, message: decision.rejection.reason };
  return { ok: true, result: { kind: "sent", task: taskId } };
}

function fromAgent(loop: Loop, tokens: Tokens, wire: WireInput, token: string): Handled {
  const session = tokens.sessionOf(token);
  if (session === null) {
    return { ok: false, message: "That session token isn't one this daemon gave." };
  }
  if (yours(wire) !== null) {
    const message = `Only you can send \`${wire.type}\`, and this call comes from an agent's session.`;
    return { ok: false, message };
  }
  const input = agents(wire);
  if (input === null) return { ok: false, message: `\`${wire.type}\` isn't in yet.` };

  const task = loop
    .all()
    .find((t) => t.phase !== "ended" && t.step.kind === "running" && t.step.session === session);
  if (task === undefined) {
    return { ok: false, message: `Session ${session} no longer works on a task.` };
  }
  const decision = loop.send(task.id, { by: "agent", session, ...input });
  if (!decision.ok) return { ok: false, message: decision.rejection.reason };
  return { ok: true, result: { kind: "sent", task: task.id } };
}

// The input as an agent's, without its session, or null when it is yours.
// `done` waits for the daemon to read the branch from git, so it isn't in yet.
function agents(input: WireInput): DistributiveOmit<AgentInput, "session"> | null {
  switch (input.type) {
    case "triage_proceed":
    case "triage_split":
    case "triage_decline":
    case "ask":
    case "progress":
    case "give_up":
    case "pass":
    case "changes":
      return input;
    default:
      return null;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// The input as one of yours, or null when it is an agent's.
function yours(input: WireInput): YourInput | null {
  switch (input.type) {
    case "add":
    case "set":
    case "reply":
    case "approve":
    case "deny":
    case "decide_proposals":
    case "pause":
    case "resume":
    case "start_now":
    case "retry":
    case "kill":
      return input;
    default:
      return null;
  }
}

function nextId(loop: Loop): TaskId {
  const highest = Math.max(0, ...loop.all().map((task) => task.id));
  return TaskId.parse(highest + 1);
}

function rows(loop: Loop): Row[] {
  return loop
    .all()
    .sort((a, b) => a.id - b.id)
    .map((task) => {
      const plan = task.phase === "build" || task.phase === "review" ? task.plan : null;
      return {
        task: task.id,
        title: task.title,
        phase: task.phase,
        intent: plan?.intent ?? null,
        rigor: plan?.rigor ?? null,
        state: state(task),
      };
    });
}

// Why a task is held, in a few words.
function held(hold: Hold): string {
  switch (hold.kind) {
    case "paused":
      return "paused";
    case "crashed":
      return "held: its agent crashed";
    case "gave_up":
      return "held: its agent gave up";
    case "loop_cap":
      return "held: too many review rounds";
    case "failed":
      return `held: ${hold.step.replaceAll("_", " ")} failed`;
  }
}

// The task's step in plain words, for `skel ls`.
function state(task: Task): string {
  if (task.phase === "ended") return task.outcome.kind;
  if (task.hold !== null) return held(task.hold);
  if (task.question !== null) return "waiting for your answer";
  return task.step.kind.replaceAll("_", " ");
}
