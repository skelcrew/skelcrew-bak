import { describe, expect, test } from "bun:test";
import {
  add,
  attach,
  branch,
  builder,
  buildRunning,
  pass,
  peek,
  planner,
  play,
  proceed,
  reviewRunning,
  run,
  set,
  start,
  stopped,
  tester,
  triageRunning,
  types,
} from "./testing";
import type { Input } from "./types";

describe("setting during triage", () => {
  test("one field is kept, and wins over the planner's call", () => {
    const { task } = play(triageRunning().task, [set({ rigor: "light" }), proceed()]);

    expect(task.phase === "build" && task.plan.rigor).toBe("light");
  });

  test("approval set during triage survives the planner's call", () => {
    const { task } = play(triageRunning().task, [set({ approve: true }), proceed()]);

    expect(task.phase === "build" && task.plan.approve).toBe(true);
  });

  test("intent and rigor together end triage, stopping the planner", () => {
    const { task, events } = play(triageRunning().task, [set({ intent: "ship", rigor: "light" })]);

    expect(types(events)).toEqual(["task.set", "session.stopping", "build.restarted"]);
    if (task.phase !== "build") throw new Error("not in build");
    expect(task.step).toEqual({ kind: "awaiting_stop" });
    expect(task.plan).toEqual({
      intent: "ship",
      rigor: "light",
      approve: false,
      brief: "Fix empty export",
      specPath: null,
    });
  });

  test("intent and rigor together end triage for a task that hasn't started", () => {
    const { task, commands } = run(add(), set({ intent: "try", rigor: "light" }));

    expect(commands).toEqual([]);
    expect(task.phase === "build" && task.step).toEqual({ kind: "queued" });
  });

  test("waits while a step is under way", () => {
    expect(peek(run(add(), start).task, set({ rigor: "full" }))).toEqual({
      ok: false,
      rejection: {
        input: "set",
        reason: "#142 is busy with a step. skel set waits until it settles.",
      },
    });
  });
});

describe("setting during build or review", () => {
  test("approval and rigor change the plan, and the builder carries on", () => {
    const { task, events, commands } = play(buildRunning().task, [
      set({ approve: true, rigor: "light" }),
    ]);

    expect(types(events)).toEqual(["task.set"]);
    expect(commands).toEqual([]);
    expect(task.phase === "build" && task.plan.approve).toBe(true);
    expect(task.phase === "build" && task.plan.rigor).toBe("light");
    expect(task.phase === "build" && task.step.kind).toBe("running");
  });

  test("a new intent stops the builder, and a fresh one starts with the new permissions", () => {
    const first = play(buildRunning().task, [set({ intent: "answer" })]);
    expect(types(first.events)).toEqual(["task.set", "session.stopping", "build.restarted"]);

    const { commands } = play(first.task, [stopped(5, builder, "saved")]);
    expect(commands[0]?.type === "start_session" && commands[0].edits).toBe(false);
  });

  test("a new intent during review stops the tester and goes back to build", () => {
    const { task } = play(reviewRunning().task, [set({ intent: "try" })]);

    expect(task.phase).toBe("build");
    expect(task.phase === "build" && task.handover).toBeNull();
  });

  test("clearing approval while it waits for you delivers, when nothing critical changed", () => {
    const awaiting = play(reviewRunning({ intent: "ship", rigor: "full", approve: true }).task, [
      pass(),
      stopped(9, tester),
    ]).task;
    const { events } = play(awaiting, [set({ approve: false })]);

    expect(types(events)).toEqual(["task.set", "output.requested"]);
  });
});

describe("attaching", () => {
  test("marks the task as with you, and the agent keeps working", () => {
    const { task, events } = play(buildRunning().task, [attach]);

    expect(types(events)).toEqual(["session.attached"]);
    expect(task.attached).toBe(true);
  });

  test("is refused when no agent is working", () => {
    expect(peek(run(add()).task, attach)).toEqual({
      ok: false,
      rejection: { input: "attach", reason: "#142 has no agent running." },
    });
  });

  test("detaching to resume hands the task back to its agent", () => {
    const detach: Input = { by: "you", type: "detach", choice: "resume" };
    const { task, events } = play(buildRunning().task, [attach, detach]);

    expect(types(events)).toEqual(["session.detached"]);
    expect(task.attached).toBe(false);
  });

  test("detaching to hand over treats the work as done", () => {
    const detach: Input = { by: "you", type: "detach", choice: "hand_over", branch };
    const { task, events } = play(buildRunning().task, [attach, detach]);

    expect(types(events)).toEqual(["session.detached", "build.done", "session.stopping"]);
    expect(task.phase === "build" && task.handover?.text).toBe("Handed over by you.");
  });

  test("handing over is only for a builder's work", () => {
    const detach: Input = { by: "you", type: "detach", choice: "hand_over", branch };

    expect(peek(play(triageRunning().task, [attach]).task, detach)).toEqual({
      ok: false,
      rejection: { input: "detach", reason: "Only a builder's work can be handed over." },
    });
  });
});

describe("deciding on proposals", () => {
  const split: Input = {
    by: "agent",
    session: planner,
    type: "triage_split",
    proposals: [
      { title: "Fix empty CSV", description: "" },
      { title: "Fix empty PDF", description: "" },
    ],
  };

  test("records your decision on each, after the task has ended", () => {
    const decide: Input = { by: "you", type: "decide_proposals", approved: [0], denied: [1] };
    const { task, events } = play(triageRunning().task, [split, decide]);

    expect(types(events)).toEqual(["proposals.decided"]);
    expect(task.phase === "ended" && task.proposals.map((p) => p.decision)).toEqual([
      "approved",
      "denied",
    ]);
  });

  test("is refused for a proposal that doesn't exist or was decided", () => {
    const decide: Input = { by: "you", type: "decide_proposals", approved: [0], denied: [] };
    const { task } = play(triageRunning().task, [split, decide]);

    expect(peek(task, decide)).toEqual({
      ok: false,
      rejection: { input: "decide_proposals", reason: "Proposal 0 of #142 isn't waiting for you." },
    });
  });
});

describe("a task from the tracker", () => {
  test("arrives like one you add, with its source", () => {
    const received: Input = {
      by: "plugin",
      type: "task_received",
      title: "Export crashes",
      description: null,
      source: {
        kind: "tracker",
        plugin: "github",
        id: "40",
        url: "https://github.com/o/r/issues/40",
      },
      plan: null,
    };
    const { task } = run(received);

    expect(task.phase).toBe("triage");
    expect(task.source).toEqual({
      kind: "tracker",
      plugin: "github",
      id: "40",
      url: "https://github.com/o/r/issues/40",
    });
  });
});

describe("set", () => {
  test("with nothing to change is refused", () => {
    expect(peek(run(add()).task, set({}))).toEqual({
      ok: false,
      rejection: { input: "set", reason: "Set intent, rigor or approval." },
    });
  });
});
