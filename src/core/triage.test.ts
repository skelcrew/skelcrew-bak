import { describe, expect, test } from "bun:test";
import { SessionId } from "./ids";
import {
  add,
  ask,
  id,
  next,
  planner,
  play,
  proceed,
  run,
  sessionEnded,
  sessionFailed,
  specCommitted,
  start,
  stopped,
  triageRunning,
  types,
  workspace,
  workspaceCreated,
  workspaceFailed,
} from "./testing";
import type { Input } from "./types";

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
          handover: null,
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

describe("the planner proceeding", () => {
  test("stops the planner, and the task moves to build to wait for the stop", () => {
    const { task, events, commands } = play(triageRunning().task, [proceed()]);

    expect(types(events)).toEqual(["task.triaged", "session.stopping"]);
    expect(commands).toEqual([
      {
        type: "stop_session",
        taskId: id,
        request: 3,
        session: planner,
        save: false,
        remove: null,
      },
    ]);
    expect(task.phase).toBe("build");
    if (task.phase !== "build") return;
    expect(task.step).toEqual({ kind: "awaiting_stop" });
    expect(task.stopping).toEqual({ session: planner, request: 3, removes: null });
    expect(task.workspace).toEqual(workspace);
    expect(task.plan).toEqual({
      intent: "ship",
      rigor: "full",
      approve: false,
      brief: "Empty reports crash. Look in the CSV writer.",
      specPath: null,
    });
  });

  test("starts the builder once the planner's stop is confirmed", () => {
    const { task, events, commands } = play(triageRunning().task, [proceed(), stopped(3, planner)]);

    expect(types(events)).toEqual(["session.stopped", "session.requested"]);
    expect(commands).toEqual([
      {
        type: "start_session",
        taskId: id,
        request: 4,
        role: "builder",
        cwd: workspace.path,
        edits: true,
        context: {
          title: "Fix empty export",
          description: null,
          plan: {
            intent: "ship",
            rigor: "full",
            approve: false,
            brief: "Empty reports crash. Look in the CSV writer.",
            specPath: null,
          },
          feedback: null,
          handover: null,
          answer: null,
        },
      },
    ]);
    expect(task.stopping).toBeNull();
    expect(task.phase === "build" && task.step).toEqual({ kind: "starting", request: 4 });
  });

  test("starts an answer's builder without edit permissions", () => {
    const { commands } = play(triageRunning().task, [
      proceed(null, { intent: "answer", rigor: "light", approve: false }),
      stopped(3, planner),
    ]);

    expect(commands[0]?.type === "start_session" && commands[0].edits).toBe(false);
  });

  test("with a spec, commits it to the branch while the planner stops", () => {
    const { task, events, commands } = play(triageRunning().task, [proceed("# Spec\n")]);

    expect(types(events)).toEqual(["task.triaged", "session.stopping"]);
    expect(commands).toEqual([
      {
        type: "stop_session",
        taskId: id,
        request: 3,
        session: planner,
        save: false,
        remove: null,
      },
      { type: "commit_spec", taskId: id, request: 4, workspace, text: "# Spec\n" },
    ]);
    expect(task.phase === "triage" && task.step.kind).toBe("committing_spec");
  });

  test("with a spec, starts the builder once both the spec and the stop are done", () => {
    const first = play(triageRunning().task, [proceed("# Spec\n"), specCommitted(4)]);
    expect(first.task.phase === "build" && first.task.step).toEqual({ kind: "awaiting_stop" });
    expect(first.task.phase === "build" && first.task.plan.specPath).toBe("docs/plans/142-fix.md");

    const { task, events } = play(first.task, [stopped(3, planner)]);
    expect(types(events)).toEqual(["session.stopped", "session.requested"]);
    expect(task.phase === "build" && task.step).toEqual({ kind: "starting", request: 5 });
  });

  test("with a spec, also works when the stop is confirmed first", () => {
    const { task, events } = play(triageRunning().task, [
      proceed("# Spec\n"),
      stopped(3, planner),
      specCommitted(4),
    ]);

    expect(types(events)).toEqual(["spec.committed", "session.requested"]);
    expect(task.phase === "build" && task.step).toEqual({ kind: "starting", request: 5 });
  });

  test("is refused while the planner's own question is open", () => {
    const { task } = play(triageRunning().task, [ask(planner)]);

    expect(next(task, proceed())).toEqual({
      ok: false,
      rejection: {
        input: "triage_proceed",
        reason: "#142 has an open question. Wait for the answer.",
      },
    });
  });
});

describe("the planner splitting or declining", () => {
  const split: Input = {
    by: "agent",
    session: planner,
    type: "triage_split",
    proposals: [
      { title: "Fix empty CSV", description: "Header only." },
      { title: "Fix empty PDF", description: "Blank page." },
    ],
  };

  test("a split ends the task, with its proposals waiting for you", () => {
    const { task, events, commands } = play(triageRunning().task, [split]);

    expect(types(events)).toEqual(["task.triaged", "session.stopping"]);
    expect(commands).toEqual([
      {
        type: "stop_session",
        taskId: id,
        request: 3,
        session: planner,
        save: false,
        remove: { path: workspace.path, deleteBranch: true },
      },
    ]);
    expect(task.phase).toBe("ended");
    if (task.phase !== "ended") return;
    expect(task.outcome).toEqual({ kind: "split" });
    expect(task.proposals).toEqual([
      { title: "Fix empty CSV", description: "Header only.", decision: "pending" },
      { title: "Fix empty PDF", description: "Blank page.", decision: "pending" },
    ]);
  });

  test("a decline ends the task with its reason", () => {
    const decline: Input = {
      by: "agent",
      session: planner,
      type: "triage_decline",
      reason: "Already fixed in #131.",
    };
    const { task } = play(triageRunning().task, [decline]);

    expect(task.phase === "ended" && task.outcome).toEqual({
      kind: "declined",
      reason: "Already fixed in #131.",
    });
  });

  test("the planner's stop is still confirmed after the task has ended", () => {
    const { task, events } = play(triageRunning().task, [split, stopped(3, planner)]);

    expect(types(events)).toEqual(["session.stopped"]);
    expect(task.stopping).toBeNull();
  });
});
