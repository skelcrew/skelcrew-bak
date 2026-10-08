import { describe, expect, test } from "bun:test";
import { SessionId } from "./ids";
import {
  add,
  id,
  next,
  planner,
  play,
  run,
  sessionEnded,
  sessionFailed,
  start,
  triageRunning,
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

describe("the planner's session", () => {
  test("starting puts the planner to work", () => {
    const { task, events } = triageRunning();

    expect(types(events)).toEqual(["session.started"]);
    expect(task.phase === "triage" && task.step).toEqual({ kind: "running", session: planner });
  });

  test("failing to start holds the task", () => {
    const { task, events } = run(add(), start, workspaceCreated(1), sessionFailed(2, "no claude"));

    expect(types(events)).toEqual(["task.held"]);
    expect(task.hold).toEqual({ kind: "failed", step: "session", message: "no claude" });
    expect(task.phase === "triage" && task.step).toEqual({ kind: "queued" });
  });

  test("ending without reporting holds the task, with its exit code and last line", () => {
    const { task } = play(triageRunning().task, [sessionEnded(2, planner, 1, "Killed")]);

    expect(task.hold).toEqual({ kind: "crashed", exitCode: 1, lastLine: "Killed" });
    expect(task.phase === "triage" && task.step).toEqual({ kind: "queued" });
  });

  test("ending before its start reply arrives still holds the task", () => {
    const { task } = run(add(), start, workspaceCreated(1), sessionEnded(2, planner, null, "x"));

    expect(task.hold).toEqual({ kind: "crashed", exitCode: null, lastLine: "x" });
  });

  test("an end report for another session is refused", () => {
    const other = SessionId.parse("session-other");

    expect(next(triageRunning().task, sessionEnded(2, other))).toEqual({
      ok: false,
      rejection: { input: "session_ended", reason: "#142's agent isn't session-other." },
    });
  });
});
