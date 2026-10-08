import { describe, expect, test } from "bun:test";
import { decide } from "./decide";
import { evolve } from "./evolve";
import { TaskId } from "./ids";
import type { Command, Config, Input, Task, TaskEvent } from "./types";

const config: Config = { maxRunning: 2, loopCap: 3, critical: ["src/auth/**"] };
const id = TaskId.parse(142);

// Sends each input through decide, and folds the accepted events through
// evolve, as the loop does. Fails the test on the first rejection, so every
// test starts from a state the real code can reach. Returns the task, and the
// events and commands of the last input.
function run(...inputs: Input[]): { task: Task; events: TaskEvent[]; commands: Command[] } {
  let task: Task | null = null;
  let events: TaskEvent[] = [];
  let commands: Command[] = [];
  for (const [i, input] of inputs.entries()) {
    const decision = decide(task, { taskId: id, at: 1_000 + i, input }, config);
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

// What decide says to one more input, without applying it.
function next(task: Task | null, input: Input) {
  return decide(task, { taskId: id, at: 9_000, input }, config);
}

const add = (title: string, description: string | null = null): Input => ({
  by: "you",
  type: "add",
  title,
  description,
  plan: null,
});

describe("adding a task", () => {
  test("waits in triage's queue", () => {
    const { task, events } = run(add("Fix empty export"));

    expect(events.map((event) => event.type)).toEqual(["task.received"]);
    expect(task.phase).toBe("triage");
    expect(task.phase === "triage" && task.step).toEqual({ kind: "queued" });
    expect(task.title).toBe("Fix empty export");
    expect(task.source).toEqual({ kind: "local" });
  });

  test("with intent and rigor skips triage, and the brief is the title and description", () => {
    const { task } = run({
      by: "you",
      type: "add",
      title: "Fix button color",
      description: "The save button is grey on the settings page.",
      plan: { intent: "ship", rigor: "light", approve: false },
    });

    expect(task.phase).toBe("build");
    if (task.phase !== "build") return;
    expect(task.step).toEqual({ kind: "queued" });
    expect(task.workspace).toBeNull();
    expect(task.plan).toEqual({
      intent: "ship",
      rigor: "light",
      approve: false,
      brief: "Fix button color\n\nThe save button is grey on the settings page.",
      specPath: null,
    });
  });

  test("is refused for a blank title", () => {
    const decision = next(null, add("  "));

    expect(decision).toEqual({
      ok: false,
      rejection: { input: "add", reason: "A task needs a title." },
    });
  });

  test("is refused when the task already exists", () => {
    const { task } = run(add("Fix empty export"));
    const decision = next(task, add("Again"));

    expect(decision).toEqual({
      ok: false,
      rejection: { input: "add", reason: "#142 already exists." },
    });
  });
});

const start: Input = { by: "daemon", type: "start" };

describe("starting triage", () => {
  test("creates the task's workspace, as request 1", () => {
    const { task, events, commands } = run(add("Fix empty export"), start);

    expect(events.map((event) => event.type)).toEqual(["workspace.requested"]);
    expect(commands).toEqual([{ type: "create_workspace", taskId: id, request: 1 }]);
    expect(task.phase === "triage" && task.step).toEqual({
      kind: "creating_workspace",
      request: 1,
    });
    expect(task.requests).toBe(1);
  });

  test("is refused when the task isn't waiting for a slot", () => {
    const { task } = run(add("Fix empty export"), start);

    expect(next(task, start)).toEqual({
      ok: false,
      rejection: { input: "start", reason: "#142 isn't waiting for a slot." },
    });
  });

  test("is refused for a task that doesn't exist", () => {
    expect(next(null, start)).toEqual({
      ok: false,
      rejection: { input: "start", reason: "#142 doesn't exist." },
    });
  });
});
