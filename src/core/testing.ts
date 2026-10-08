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

export const copy: TesterCopy = { path: "/repo/.skelcrew/review/142", commit: sha("b") };

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
