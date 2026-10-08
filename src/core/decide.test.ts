import { describe, expect, test } from "bun:test";
import { decide } from "./decide";
import { evolve } from "./evolve";
import { TaskId } from "./ids";
import {
  add,
  config,
  id,
  pause,
  peek,
  reviewed,
  run,
  start,
  triageRunning,
  types,
} from "./testing";
import type { TaskEvent } from "./types";

describe("adding a task", () => {
  test("waits in triage's queue", () => {
    const { task, events } = run(add("Fix empty export"));

    expect(types(events)).toEqual(["task.received"]);
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
    expect(peek(null, add("  "))).toEqual({
      ok: false,
      rejection: { input: "add", reason: "A task needs a title." },
    });
  });

  test("is refused when the task already exists", () => {
    const { task } = run(add());

    expect(peek(task, add("Again"))).toEqual({
      ok: false,
      rejection: { input: "add", reason: "#142 already exists." },
    });
  });
});

describe("starting triage", () => {
  test("creates the task's workspace, as request 1", () => {
    const { task, events, commands } = run(add(), start);

    expect(types(events)).toEqual(["workspace.requested"]);
    expect(commands).toEqual([{ type: "create_workspace", taskId: id, request: 1 }]);
    expect(task.phase === "triage" && task.step).toEqual({
      kind: "creating_workspace",
      request: 1,
    });
    expect(task.requests).toBe(1);
  });

  test("is refused when the task isn't waiting for a slot", () => {
    const { task } = run(add(), start);

    expect(peek(task, start)).toEqual({
      ok: false,
      rejection: { input: "start", reason: "#142 isn't waiting for a slot." },
    });
  });

  test("is refused for a task that doesn't exist", () => {
    expect(peek(null, start)).toEqual({
      ok: false,
      rejection: { input: "start", reason: "#142 doesn't exist." },
    });
  });
});

describe("AGENTS.md, code rules: every event belongs to its task", () => {
  test("an input for another task number is refused", () => {
    const { task } = triageRunning();
    const decision = decide(task, { taskId: TaskId.parse(7), at: 0, input: pause }, config);

    expect(decision).toEqual({
      ok: false,
      rejection: { input: "pause", reason: "This input is for #7, but the task is #142." },
    });
  });
});

describe("a damaged log", () => {
  test("stops replay: evolve refuses an event that doesn't fit", () => {
    const { task } = run(add());
    const misplaced: TaskEvent = {
      v: 1,
      taskId: id,
      at: 0,
      type: "review.passed",
      commit: reviewed.head,
      evidence: "",
    };

    expect(evolve(task, misplaced).ok).toBe(false);
  });
});
