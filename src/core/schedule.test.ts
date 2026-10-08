import { describe, expect, test } from "bun:test";
import { TaskId } from "./ids";
import { schedule, slotsInUse } from "./schedule";
import {
  add,
  ask,
  attach,
  builder,
  buildRunning,
  config,
  kill,
  pause,
  planner,
  play,
  reply,
  resume,
  run,
  stopped,
  triageRunning,
} from "./testing";
import type { Task } from "./types";

// The same task under another number and age, so several can share the
// scheduler.
function as(task: Task, n: number, createdAt = n): Task {
  return { ...task, id: TaskId.parse(n), createdAt };
}

const queued = (n: number, createdAt = n) => as(run(add()).task, n, createdAt);
const working = (n: number) => as(buildRunning().task, n);

describe("the scheduler", () => {
  test("starts queued tasks, oldest first, up to max_running", () => {
    const tasks = [queued(3, 30), queued(1, 10), queued(2, 20)];

    expect(schedule(tasks, config, 0)).toEqual([TaskId.parse(1), TaskId.parse(2)]);
  });

  test("counts working agents, and starts and stops in flight, against max_running", () => {
    expect(schedule([working(1), queued(2)], config, 0)).toEqual([TaskId.parse(2)]);
    expect(schedule([working(1), queued(2)], config, 1)).toEqual([]);
  });

  test("skips held tasks", () => {
    const held = as(run(add(), pause).task, 1);

    expect(schedule([held, queued(2)], config, 0)).toEqual([TaskId.parse(2)]);
  });

  test("puts kept answers first, then resumed tasks, then the queue", () => {
    const asked = as(play(triageRunning().task, [ask(planner), reply()]).task, 3, 30);
    const resumed = as(
      play(buildRunning().task, [pause, stopped(5, builder, "saved"), resume]).task,
      4,
      40,
    );
    const tasks = [queued(1, 10), resumed, asked];

    expect(schedule(tasks, { ...config, maxRunning: 3 }, 0)).toEqual([
      TaskId.parse(3),
      TaskId.parse(4),
      TaskId.parse(1),
    ]);
  });
});

describe("slots in use", () => {
  test("an agent waiting for your answer holds none", () => {
    const asked = play(triageRunning().task, [ask(planner)]).task;

    expect(slotsInUse([asked], 0)).toBe(0);
  });

  test("an attached task keeps its slot, since its agent keeps working", () => {
    const attached = play(buildRunning().task, [attach]).task;

    expect(slotsInUse([attached], 0)).toBe(1);
  });

  test("an agent still stopping holds its slot, even once its task has ended", () => {
    const killed = play(buildRunning().task, [kill]).task;

    expect(slotsInUse([killed], 0)).toBe(1);
  });

  test("starts and stops the task no longer records count too", () => {
    expect(slotsInUse([], 2)).toBe(2);
  });
});
