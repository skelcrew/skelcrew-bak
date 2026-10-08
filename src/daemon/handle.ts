// What the daemon does with one request: turns it into an input for the loop,
// or reads the tasks for `skel ls`, and says what came of it.

import { TaskId } from "../core/ids";
import type { Task, YourInput } from "../core/types";
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

type Handled = { ok: true; result: Result } | { ok: false; message: string };

// One line in, one line out. A line that can't be read is refused, and the
// daemon carries on.
export function answerLine(loop: Loop, line: string): string {
  const parsed = parseRequest(line);
  if (!parsed.ok) return refusal(parsed.message);
  const { id, token, call } = parsed.value;
  const handled = handle(loop, call, token);
  const answer: Answer = handled.ok
    ? { v: VERSION, id, ok: true, result: handled.result }
    : { v: VERSION, id, ok: false, message: handled.message };
  return `${JSON.stringify(answer)}\n`;
}

export function handle(loop: Loop, call: Call, token: string | null): Handled {
  if (call.type === "ls") return { ok: true, result: { kind: "tasks", tasks: rows(loop) } };

  // Session tokens come with the agents' commands.
  if (token !== null) return { ok: false, message: "Agents' commands aren't in yet." };
  const input = yours(call.input);
  if (input === null) {
    return { ok: false, message: `\`${call.input.type}\` is an agent's command.` };
  }

  // A new task gets the next number. Every other input names its task.
  const taskId = input.type === "add" ? nextId(loop) : call.task;
  if (taskId === null) return { ok: false, message: "Say which task." };
  const decision = loop.send(taskId, { by: "you", ...input });
  if (!decision.ok) return { ok: false, message: decision.rejection.reason };
  return { ok: true, result: { kind: "sent", task: taskId } };
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

// The task's step in plain words, for `skel ls`.
function state(task: Task): string {
  if (task.phase === "ended") return task.outcome.kind;
  if (task.hold !== null) return "held";
  if (task.question !== null) return "waiting for your answer";
  return task.step.kind.replaceAll("_", " ");
}
