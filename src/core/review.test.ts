import { describe, expect, test } from "bun:test";
import {
  approve,
  branch,
  builder,
  buildRunning,
  changes,
  config,
  copy,
  copyCreated,
  delivered,
  deliveredReport,
  deliveryFailed,
  deny,
  done,
  doneAnswer,
  id,
  mainMerged,
  pass,
  pause,
  peek,
  play,
  reviewed,
  reviewRunning,
  sessionStarted,
  set,
  sha,
  stopped,
  tester,
  types,
} from "./testing";
import type { Input } from "./types";

describe("the tester's copy arriving", () => {
  test("starts the tester in it, read only, told what was handed over", () => {
    const { task, events, commands } = play(buildRunning().task, [
      done(),
      stopped(5, builder, "saved"),
      mainMerged(6),
      copyCreated(7),
    ]);

    expect(types(events)).toEqual(["copy.created", "session.requested"]);
    const start = commands[0];
    if (start?.type !== "start_session") throw new Error("no session started");
    expect(start).toMatchObject({ request: 8, role: "tester", cwd: copy.path, edits: false });
    expect(start.context.handover).toEqual({
      kind: "summary",
      text: "Empty reports now export a header row.",
      branch,
    });
    expect(task.phase === "review" && task.copy).toEqual(copy);
    expect(task.phase === "review" && task.step).toEqual({ kind: "starting", request: 8 });
  });

  test("puts the tester to work once its session starts", () => {
    const { task } = reviewRunning();

    expect(task.phase === "review" && task.step).toEqual({ kind: "running", session: tester });
  });
});

describe("the tester passing", () => {
  test("stops the tester, removes its copy, and delivers the reviewed commit", () => {
    const { task, events, commands } = play(reviewRunning().task, [pass("bun test: 212 pass")]);

    expect(types(events)).toEqual(["review.passed", "session.stopping", "output.requested"]);
    expect(events[0]).toMatchObject({ commit: reviewed.head, evidence: "bun test: 212 pass" });
    expect(commands).toEqual([
      {
        type: "stop_session",
        taskId: id,
        request: 9,
        session: tester,
        save: false,
        remove: { path: copy.path, deleteBranch: false },
      },
      {
        type: "deliver",
        taskId: id,
        request: 10,
        intent: "ship",
        reviewed,
        handover: { kind: "summary", text: "Empty reports now export a header row.", branch },
        evidence: "bun test: 212 pass",
      },
    ]);
    expect(task.phase === "review" && task.step).toEqual({ kind: "delivering", request: 10 });
  });

  test("waits for your sign-off when the task is flagged", () => {
    const { task, events } = play(
      reviewRunning({ intent: "ship", rigor: "full", approve: true }).task,
      [pass()],
    );

    expect(types(events)).toEqual(["review.passed", "session.stopping", "approval.requested"]);
    expect(task.phase === "review" && task.step).toEqual({ kind: "awaiting_approval" });
  });

  test("waits for your sign-off when a critical file changed, flag or not", () => {
    const touched = { head: reviewed.head, changedFiles: ["src/auth/token.ts", "README.md"] };
    const { events } = play(reviewRunning(undefined, touched).task, [pass()]);

    expect(events[2]).toMatchObject({
      type: "approval.requested",
      criticalFiles: ["src/auth/token.ts"],
    });
  });
});

describe("the tester asking for changes", () => {
  test("stops the tester, and a fresh builder starts with the findings once it has", () => {
    const first = play(reviewRunning().task, [changes("Missing a column.")]);
    expect(types(first.events)).toEqual(["review.changes_requested", "session.stopping"]);
    expect(first.task.phase === "build" && first.task.loops).toBe(1);

    const { task, commands } = play(first.task, [stopped(9, tester)]);
    expect(commands[0]?.type === "start_session" && commands[0].context.feedback).toEqual({
      kind: "findings",
      text: "Missing a column.",
    });
    expect(task.phase === "build" && task.step).toEqual({ kind: "starting", request: 10 });
  });

  test("at the loop cap holds the task with the findings", () => {
    const { task } = play(reviewRunning().task, [changes("Still wrong.")], {
      ...config,
      loopCap: 1,
    });

    expect(task.hold).toEqual({ kind: "loop_cap", findings: "Still wrong." });
  });
});

describe("your sign-off", () => {
  const awaiting = () =>
    play(reviewRunning({ intent: "ship", rigor: "full", approve: true }).task, [pass()]).task;

  test("approving delivers the reviewed commit", () => {
    const { events, commands } = play(awaiting(), [approve]);

    expect(types(events)).toEqual(["approval.given", "output.requested"]);
    expect(events[0]).toMatchObject({ commit: reviewed.head });
    expect(commands[0]?.type).toBe("deliver");
  });

  test("denying sends the task back to build with your note, waiting for a slot", () => {
    const { task } = play(awaiting(), [deny("Use the existing helper.")]);

    if (task.phase !== "build") throw new Error("not in build");
    expect(task.step).toEqual({ kind: "queued" });
    expect(task.feedback).toEqual({ kind: "denied", note: "Use the existing helper." });
    expect(task.loops).toBe(0);
  });

  test("is refused when nothing waits for it", () => {
    expect(peek(reviewRunning().task, approve)).toEqual({
      ok: false,
      rejection: { input: "approve", reason: "#142 isn't waiting for your sign-off." },
    });
  });
});

describe("delivery", () => {
  const delivering = () => play(reviewRunning().task, [pass()]).task;

  test("ends the task as done, and removes its workspace", () => {
    const { task, events, commands } = play(delivering(), [stopped(9, tester), delivered(10)]);

    expect(types(events)).toEqual(["output.delivered", "workspace.removed"]);
    expect(commands).toEqual([
      {
        type: "remove_workspace",
        path: "/repo/.skelcrew/worktrees/142-fix-empty-export",
        deleteBranch: false,
      },
    ]);
    expect(task.phase === "ended" && task.outcome).toEqual({
      kind: "done",
      delivered: { kind: "branch", commit: reviewed.head, ref: "skel/142-fix-empty-export" },
    });
  });

  test("that fails holds the task, and a retry can send it again", () => {
    const { task } = play(delivering(), [deliveryFailed(10, "push rejected")]);

    expect(task.hold).toEqual({ kind: "failed", step: "delivery", message: "push rejected" });
    expect(task.phase === "review" && task.step).toEqual({ kind: "delivering", request: null });
    expect(peek(task, delivered(10))).toEqual({ ok: true, events: [], commands: [] });
  });

  test("of an answer keeps the tasks it proposes, waiting for you", () => {
    const answered = play(buildRunning({ intent: "answer", rigor: "light", approve: false }).task, [
      {
        by: "agent",
        session: builder,
        type: "done_answer",
        report: "Use a queue.",
        proposals: [{ title: "Add a queue", description: "For exports." }],
        branch,
      },
      stopped(5, builder),
      copyCreated(6, branch.head),
      sessionStarted(7, tester),
      pass(),
      stopped(8, tester),
      deliveredReport(9),
    ]).task;

    expect(answered.phase === "ended" && answered.proposals).toEqual([
      { title: "Add a queue", description: "For exports.", decision: "pending" },
    ]);
  });
});

describe("a try", () => {
  test("is delivered straight after its merge, with no review", () => {
    const { task, events } = play(
      buildRunning({ intent: "try", rigor: "light", approve: false }).task,
      [done(), stopped(5, builder, "saved"), mainMerged(6)],
    );

    expect(types(events)).toEqual(["main.merged", "output.requested"]);
    expect(task.phase === "build" && task.step).toEqual({ kind: "delivering", request: 7 });
  });
});

describe("rule 6: one reviewed commit", () => {
  test("a tester's copy of another commit isn't reviewed, and is removed", () => {
    const merged = play(buildRunning().task, [done(), stopped(5, builder, "saved"), mainMerged(6)]);
    const wrong: Input = {
      by: "plugin",
      type: "copy_created",
      request: 7,
      copy: { path: copy.path, commit: sha("e") },
    };
    const { task, commands } = play(merged.task, [wrong]);

    expect(task.hold?.kind).toBe("failed");
    expect(commands).toEqual([{ type: "remove_workspace", path: copy.path, deleteBranch: false }]);
  });

  test("a delivery of another commit holds the task instead of ending it", () => {
    const delivering = play(reviewRunning().task, [pass()]).task;
    const { task } = play(delivering, [delivered(10, sha("e"))]);

    expect(task.phase).toBe("review");
    expect(task.hold).toEqual({
      kind: "failed",
      step: "delivery",
      message: `Delivered ${sha("e")}, but the reviewed commit is ${reviewed.head}.`,
    });
  });

  test("an answer's delivery must be its report, not a branch", () => {
    const answering = play(
      buildRunning({ intent: "answer", rigor: "light", approve: false }).task,
      [
        doneAnswer(),
        stopped(5, builder),
        copyCreated(6, branch.head),
        sessionStarted(7, tester),
        pass(),
      ],
    ).task;
    const { task } = play(answering, [delivered(9, branch.head)]);

    expect(task.hold?.kind).toBe("failed");
  });
});

describe("approval on a held task", () => {
  test("waits until you resume it", () => {
    const awaiting = play(reviewRunning({ intent: "ship", rigor: "full", approve: true }).task, [
      pass(),
      stopped(9, tester),
      pause,
    ]).task;

    expect(peek(awaiting, approve)).toEqual({
      ok: false,
      rejection: { input: "approve", reason: "#142 is held. Resume it first." },
    });
    expect(peek(awaiting, set({ approve: false })).ok).toBe(false);
  });
});

describe("an ended task", () => {
  test("keeps what was handed over", () => {
    const { task } = play(reviewRunning().task, [pass(), stopped(9, tester), delivered(10)]);

    expect(task.phase === "ended" && task.handover?.text).toBe(
      "Empty reports now export a header row.",
    );
  });
});

describe("your sign-off on a held task", () => {
  const heldAwaiting = () =>
    play(reviewRunning({ intent: "ship", rigor: "full", approve: true }).task, [
      pass(),
      stopped(9, tester),
      pause,
    ]).task;

  test("deny waits until you resume it, like approve", () => {
    expect(peek(heldAwaiting(), deny())).toEqual({
      ok: false,
      rejection: { input: "deny", reason: "#142 is held. Resume it first." },
    });
  });

  test("changing rigor doesn't, when nothing lifts the approval", () => {
    const critical = { head: reviewed.head, changedFiles: ["src/auth/token.ts"] };
    const awaiting = play(reviewRunning(undefined, critical).task, [
      pass(),
      stopped(9, tester),
      pause,
    ]).task;

    expect(peek(awaiting, set({ rigor: "light" })).ok).toBe(true);
  });
});
