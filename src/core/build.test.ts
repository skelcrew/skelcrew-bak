import { describe, expect, test } from "bun:test";
import {
  addPlanned,
  ask,
  branch,
  builder,
  buildRunning,
  config,
  done,
  doneAnswer,
  id,
  mainConflict,
  mainFailed,
  mainMerged,
  next,
  play,
  reply,
  reviewed,
  run,
  sessionStarted,
  start,
  stopped,
  types,
  workspace,
  workspaceCreated,
} from "./testing";

describe("starting a build that skipped triage", () => {
  test("creates the workspace first", () => {
    const { task, events, commands } = run(addPlanned(), start);

    expect(types(events)).toEqual(["workspace.requested"]);
    expect(commands).toEqual([{ type: "create_workspace", taskId: id, request: 1 }]);
    expect(task.phase === "build" && task.step).toEqual({ kind: "creating_workspace", request: 1 });
  });

  test("then starts the builder in it, with the brief from your title", () => {
    const { task, events, commands } = run(addPlanned(), start, workspaceCreated(1));

    expect(types(events)).toEqual(["workspace.created", "session.requested"]);
    expect(commands[0]?.type === "start_session" && commands[0].role).toBe("builder");
    expect(commands[0]?.type === "start_session" && commands[0].context.plan?.brief).toBe(
      "Fix button color",
    );
    expect(task.phase === "build" && task.workspace).toEqual(workspace);
    expect(task.phase === "build" && task.step).toEqual({ kind: "starting", request: 2 });
  });

  test("puts the builder to work once its session starts", () => {
    const { task } = run(addPlanned(), start, workspaceCreated(1), sessionStarted(2, builder));

    expect(task.phase === "build" && task.step).toEqual({ kind: "running", session: builder });
  });
});

describe("the builder handing over", () => {
  test("stops the builder, saving its work, and keeps what it handed over", () => {
    const { task, events, commands } = play(buildRunning().task, [done()]);

    expect(types(events)).toEqual(["build.done", "session.stopping"]);
    expect(commands).toEqual([
      { type: "stop_session", taskId: id, request: 5, session: builder, save: true, remove: null },
    ]);
    if (task.phase !== "build") throw new Error("not in build");
    expect(task.step).toEqual({ kind: "awaiting_stop" });
    expect(task.handover).toEqual({
      kind: "summary",
      text: "Empty reports now export a header row.",
      branch,
    });
  });

  test("merges main into the branch once the builder's stop is confirmed", () => {
    const { task, events, commands } = play(buildRunning().task, [
      done(),
      stopped(5, builder, "saved"),
    ]);

    expect(types(events)).toEqual(["session.stopped", "main.requested"]);
    expect(commands).toEqual([{ type: "merge_main", taskId: id, request: 6, workspace }]);
    expect(task.phase === "build" && task.step).toEqual({ kind: "merging_main", request: 6 });
  });

  test("is refused while the builder's own question is open", () => {
    const { task } = play(buildRunning().task, [ask(builder), reply()]);

    expect(next(task, done())).toEqual({
      ok: false,
      rejection: { input: "done", reason: "#142 has an open question. Wait for the answer." },
    });
  });

  test("is refused when the branch changed nothing", () => {
    expect(
      next(buildRunning().task, done("Nothing.", { head: branch.head, changedFiles: [] })),
    ).toEqual({
      ok: false,
      rejection: { input: "done", reason: "The branch has no changes." },
    });
  });

  test("with a report is refused for a ship task", () => {
    expect(next(buildRunning().task, doneAnswer())).toEqual({
      ok: false,
      rejection: {
        input: "done_answer",
        reason: "#142 is a ship task. Hand it over with done, not a report.",
      },
    });
  });
});

describe("merging main", () => {
  const merging = () => play(buildRunning().task, [done(), stopped(5, builder, "saved")]).task;

  test("fixes the reviewed commit, and asks for the tester's copy of it", () => {
    const { task, events, commands } = play(merging(), [mainMerged(6)]);

    expect(types(events)).toEqual(["main.merged", "workspace.requested"]);
    expect(commands).toEqual([
      { type: "create_copy", taskId: id, request: 7, commit: reviewed.head },
    ]);
    expect(task.phase).toBe("review");
    if (task.phase !== "review") return;
    expect(task.reviewed).toEqual(reviewed);
    expect(task.step).toEqual({ kind: "creating_copy", request: 7 });
  });

  test("that conflicts sends a fresh builder back to finish it, as a loop", () => {
    const { task, events, commands } = play(merging(), [mainConflict(6, ["src/export/csv.ts"])]);

    expect(types(events)).toEqual(["main.conflict", "session.requested"]);
    expect(commands[0]?.type === "start_session" && commands[0].context.feedback).toEqual({
      kind: "conflict",
      files: ["src/export/csv.ts"],
    });
    if (task.phase !== "build") throw new Error("not in build");
    expect(task.loops).toBe(1);
    expect(task.handover).toBeNull();
    expect(task.step).toEqual({ kind: "starting", request: 7 });
  });

  test("that conflicts at the loop cap holds the task", () => {
    const { task } = play(merging(), [mainConflict(6)], { ...config, loopCap: 1 });

    expect(task.hold).toEqual({
      kind: "loop_cap",
      findings: "Merging main conflicted in src/export/csv.ts.",
    });
  });

  test("that fails for another reason holds the task, and the merge can be retried", () => {
    const { task } = play(merging(), [mainFailed(6, "index.lock exists")]);

    expect(task.hold).toEqual({ kind: "failed", step: "merge_main", message: "index.lock exists" });
    expect(task.phase === "build" && task.step).toEqual({ kind: "merging_main", request: null });
    expect(next(task, mainMerged(6)).ok).toBe(false);
  });
});

describe("an answer handing over", () => {
  const answering = () => buildRunning({ intent: "answer", rigor: "light", approve: false }).task;

  test("stops the builder without saving, since it can't edit", () => {
    const { commands } = play(answering(), [doneAnswer()]);

    expect(commands[0]?.type === "stop_session" && commands[0].save).toBe(false);
  });

  test("goes straight to review with its own commit, since it merges nothing", () => {
    const { task, events } = play(answering(), [doneAnswer(), stopped(5, builder)]);

    expect(types(events)).toEqual(["session.stopped", "review.ready", "workspace.requested"]);
    expect(task.phase === "review" && task.reviewed).toEqual(branch);
  });

  test("with a summary is refused", () => {
    expect(next(answering(), done())).toEqual({
      ok: false,
      rejection: { input: "done", reason: "#142 is an answer task. Hand it over with a report." },
    });
  });
});
