import { describe, expect, test } from "bun:test";
import {
  add,
  id,
  run,
  start,
  types,
  workspace,
  workspaceCreated,
  workspaceFailed,
} from "./testing";

describe("the workspace arriving in triage", () => {
  test("starts the planner in it, read only, as request 2", () => {
    const { task, events, commands } = run(
      add("Fix empty export", "Crashes on reports with no rows."),
      start,
      workspaceCreated(1),
    );

    expect(types(events)).toEqual(["workspace.created", "session.requested"]);
    expect(commands).toEqual([
      {
        type: "start_session",
        taskId: id,
        request: 2,
        role: "planner",
        cwd: workspace.path,
        edits: false,
        context: {
          title: "Fix empty export",
          description: "Crashes on reports with no rows.",
          plan: null,
          feedback: null,
          answer: null,
        },
      },
    ]);
    expect(task.phase === "triage" && task.workspace).toEqual(workspace);
    expect(task.phase === "triage" && task.step).toEqual({ kind: "starting", request: 2 });
    expect(task.requests).toBe(2);
  });

  test("that failed holds the task, back in the queue for a retry", () => {
    const { task, events, commands } = run(add(), start, workspaceFailed(1, "disk full"));

    expect(types(events)).toEqual(["task.held"]);
    expect(commands).toEqual([]);
    expect(task.hold).toEqual({ kind: "failed", step: "workspace", message: "disk full" });
    expect(task.phase === "triage" && task.step).toEqual({ kind: "queued" });
  });
});
