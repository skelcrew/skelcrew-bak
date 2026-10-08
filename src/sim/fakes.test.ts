import { expect, test } from "bun:test";
import { id, workspace } from "../core/testing";
import type { Command } from "../core/types";
import { FakeTools } from "./fakes";

const merge = (request: number): Command => ({
  type: "merge_main",
  taskId: id,
  request,
  workspace,
});

// A daemon that restarts makes new fakes, and a command sent again must get
// the same answer it got before.
test("a command gets the same answer from fakes made after a restart", () => {
  const before = new FakeTools();
  before.answer(merge(3));
  const answered = before.answer(merge(6));

  expect(new FakeTools().answer(merge(6))).toEqual(answered);
});

test("different commands make different commits", () => {
  const fakes = new FakeTools();
  const first = fakes.answer(merge(6));
  const second = fakes.answer(merge(9));

  expect(first?.type === "main_merged" && second?.type === "main_merged").toBe(true);
  expect(first).not.toEqual(second);
});

test("a branch is the same for the same moment of a task, and differs otherwise", () => {
  expect(new FakeTools().branch("142:5")).toEqual(new FakeTools().branch("142:5"));
  expect(new FakeTools().branch("142:5")).not.toEqual(new FakeTools().branch("142:7"));
});
