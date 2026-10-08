import { describe, expect, test } from "bun:test";
import { SessionId } from "./ids";
import {
  ask,
  deliverAnswer,
  peek,
  planner,
  play,
  reply,
  sessionEnded,
  triageRunning,
  types,
} from "./testing";
import type { Input } from "./types";

describe("an agent asking", () => {
  test("opens a question with its options", () => {
    const { task, events } = play(triageRunning().task, [ask(planner, "Include archived rows?")]);

    expect(types(events)).toEqual(["question.asked"]);
    expect(task.question).toEqual({
      session: planner,
      text: "Include archived rows?",
      options: ["Yes", "No"],
      askedAt: 1_000,
    });
  });

  test("is refused while its question is still open", () => {
    const { task } = play(triageRunning().task, [ask(planner)]);

    expect(peek(task, ask(planner, "And deleted ones?"))).toEqual({
      ok: false,
      rejection: { input: "ask", reason: "#142 already has an open question." },
    });
  });

  test("needs two to four options", () => {
    const oneOption: Input = {
      by: "agent",
      session: planner,
      type: "ask",
      text: "Ok?",
      options: ["Yes"],
    };

    expect(peek(triageRunning().task, oneOption)).toEqual({
      ok: false,
      rejection: { input: "ask", reason: "A question needs two to four options." },
    });
  });

  test("is only heard from the task's current agent", () => {
    const stranger = SessionId.parse("session-stranger");

    expect(peek(triageRunning().task, ask(stranger))).toEqual({
      ok: false,
      rejection: { input: "ask", reason: "#142's agent isn't session-stranger." },
    });
  });
});

describe("your reply", () => {
  test("is kept until a slot is free", () => {
    const { task, events, commands } = play(triageRunning().task, [ask(planner), reply("No")]);

    expect(types(events)).toEqual(["answer.kept"]);
    expect(commands).toEqual([]);
    expect(task.keptAnswer).toEqual({ text: "No", keptAt: 1_001 });
    expect(task.question).not.toBeNull();
  });

  test("is typed into the agent's session once the daemon finds it a slot", () => {
    const { task, events, commands } = play(triageRunning().task, [
      ask(planner),
      reply("No"),
      deliverAnswer,
    ]);

    expect(types(events)).toEqual(["question.answered"]);
    expect(commands).toEqual([{ type: "type_into_session", session: planner, text: "No" }]);
    expect(task.question).toBeNull();
    expect(task.keptAnswer).toBeNull();
  });

  test("is refused when there is no open question", () => {
    expect(peek(triageRunning().task, reply())).toEqual({
      ok: false,
      rejection: { input: "reply", reason: "#142 has no open question." },
    });
  });

  test("is refused when an answer already waits", () => {
    const { task } = play(triageRunning().task, [ask(planner), reply("No")]);

    expect(peek(task, reply("Yes"))).toEqual({
      ok: false,
      rejection: {
        input: "reply",
        reason: "#142 is already answered. Your answer waits for a slot.",
      },
    });
  });

  test("is refused when blank", () => {
    const { task } = play(triageRunning().task, [ask(planner)]);

    expect(peek(task, reply("  "))).toEqual({
      ok: false,
      rejection: { input: "reply", reason: "A reply needs text." },
    });
  });
});

describe("a question whose agent is gone", () => {
  test("goes with it", () => {
    const { task } = play(triageRunning().task, [ask(planner), reply(), sessionEnded(2, planner)]);

    expect(task.question).toBeNull();
    expect(task.keptAnswer).toBeNull();
  });
});
