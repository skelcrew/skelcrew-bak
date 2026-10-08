// What the daemon does with one request: turns it into an input for the loop,
// or reads the tasks for `skel ls`, and says what came of it.

import * as z from "zod";
import { TaskId } from "../core/ids";
import type { BranchFacts, Hold, Task, YourInput } from "../core/types";
import type { Loop } from "../loop/loop";
import {
  type Answer,
  type Call,
  encode,
  parseRequest,
  type Result,
  type Row,
  VERSION,
  type WireInput,
} from "../protocol/protocol";
import { agentInput } from "./agent-input";
import { refusal } from "./server";
import type { Tokens } from "./tokens";

type Handled = { ok: true; result: Result } | { ok: false; message: string };

// What the daemon handles requests with. `branchOf` reads what git says about
// a task's branch, which the daemon adds to an agent's done.
export type Context = { loop: Loop; tokens: Tokens; branchOf: (task: Task) => BranchFacts };

// One line in, one line out. A line that can't be read is refused, and the
// daemon carries on.
export function answerLine(context: Context, line: string): string {
  const parsed = parseRequest(line);
  if (!parsed.ok) return refusal(parsed.message, idOf(line));
  const { id, token, call } = parsed.value;
  const handled = guarded(() => handle(context, call, token));
  const answer: Answer = handled.ok
    ? { v: VERSION, id, ok: true, result: handled.result }
    : { v: VERSION, id, ok: false, message: handled.message };
  return encode(answer);
}

// The id a request that can't be read still carries, so its refusal reaches
// the caller as the answer to it. "unknown" when there is none.
function idOf(line: string): string {
  try {
    const id = z.object({ id: z.string().min(1) }).safeParse(JSON.parse(line));
    return id.success ? id.data.id : "unknown";
  } catch {
    return "unknown";
  }
}

// A failure inside one request, such as git failing, is refused with why and
// logged, rather than taking down the daemon and every task it runs.
function guarded(handled: () => Handled): Handled {
  try {
    return handled();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`A request failed: ${reason}`);
    return { ok: false, message: `The daemon failed on this request: ${reason}` };
  }
}

// A call with a token comes from that token's session, and goes to the task
// the session works on. One without comes from you. Which inputs each may
// send is checked here, and the core refuses anything outside the session's
// role and phase.
export function handle(context: Context, call: Call, token: string | null): Handled {
  const loop = context.loop;
  if (call.type === "ls") return { ok: true, result: { kind: "tasks", tasks: rows(loop) } };
  if (token !== null) return fromAgent(context, call.input, token);

  const input = yours(call.input);
  if (input === null) {
    const message = `\`${call.input.type}\` is an agent's command. It needs the session's token in SKELCREW_SESSION.`;
    return { ok: false, message };
  }

  // A new task gets the next number. Every other input names its task.
  const taskId = input.type === "add" ? nextId(loop) : call.task;
  if (taskId === null) return { ok: false, message: "Say which task." };
  const task = loop.task(taskId);
  if ((input.type === "approve" || input.type === "deny") && task?.phase === "ended") {
    return decideProposals(loop, task, input.type === "approve");
  }
  const decision = loop.send(taskId, { by: "you", ...input });
  if (!decision.ok) return { ok: false, message: decision.rejection.reason };
  return { ok: true, result: { kind: "sent", task: taskId } };
}

function fromAgent(context: Context, wire: WireInput, token: string): Handled {
  const { loop, tokens } = context;
  const session = tokens.sessionOf(token);
  if (session === null) {
    return { ok: false, message: "That session token isn't one this daemon gave." };
  }
  if (yours(wire) !== null) {
    const message = `Only you can send \`${wire.type}\`, and this call comes from an agent's session.`;
    return { ok: false, message };
  }
  const task = loop
    .all()
    .find((t) => t.phase !== "ended" && t.step.kind === "running" && t.step.session === session);
  if (task === undefined) {
    return { ok: false, message: `Session ${session} no longer works on a task.` };
  }
  const made = agentInput(wire, () => context.branchOf(task));
  if (made === null) return { ok: false, message: `\`${wire.type}\` is your command.` };
  if (!made.ok) return made;
  const decision = loop.send(task.id, { by: "agent", session, ...made.input });
  if (!decision.ok) return { ok: false, message: decision.rejection.reason };
  return { ok: true, result: { kind: "sent", task: task.id } };
}

// skel approve or deny on an ended task decides every proposal waiting, as
// the spec's CLI says. The core records the decision, and each approved
// proposal is then added as a task of its own.
function decideProposals(loop: Loop, task: Task & { phase: "ended" }, approve: boolean): Handled {
  const waiting = task.proposals.flatMap((proposal, i) =>
    proposal.decision === "pending" ? [i] : [],
  );
  if (waiting.length === 0) return { ok: false, message: `#${task.id} has no proposals waiting.` };
  const decision = loop.send(task.id, {
    by: "you",
    type: "decide_proposals",
    approved: approve ? waiting : [],
    denied: approve ? [] : waiting,
  });
  if (!decision.ok) return { ok: false, message: decision.rejection.reason };
  if (approve) {
    for (const i of waiting) {
      const proposal = task.proposals[i];
      if (proposal === undefined) continue;
      const added = { title: proposal.title, description: proposal.description, plan: null };
      loop.send(nextId(loop), { by: "you", type: "add", ...added });
    }
  }
  return { ok: true, result: { kind: "sent", task: task.id } };
}

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
  let highest = 0;
  for (const task of loop.all()) highest = Math.max(highest, task.id);
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
