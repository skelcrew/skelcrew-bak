import { describe, expect, test } from "bun:test";
import { TaskId } from "../core/ids";
import { config } from "../core/testing";
import { Simulator } from "./simulator";

const task = (n: number) => TaskId.parse(n);

describe("the simulator", () => {
  test("runs a task from add to done", () => {
    const sim = new Simulator(config);
    sim.add(task(1));
    sim.run();

    expect(sim.outcome(task(1))).toBe("done");
  });

  test("runs an answer to done, delivered as a report", () => {
    const sim = new Simulator(config);
    sim.add(task(1), { intent: "answer" });
    sim.run();

    expect(sim.outcome(task(1))).toBe("done");
    expect(sim.delivered(task(1))?.kind).toBe("report");
  });

  test("loops through review and conflicts, then finishes", () => {
    const sim = new Simulator(config);
    sim.add(task(1), { changes: 1, conflicts: 1 });
    sim.run();

    expect(sim.outcome(task(1))).toBe("done");
  });

  test("runs several tasks without ever going past max_running", () => {
    const sim = new Simulator({ ...config, maxRunning: 2 });
    for (const n of [1, 2, 3, 4, 5]) sim.add(task(n), { changes: n % 2 });
    sim.run();

    for (const n of [1, 2, 3, 4, 5]) expect(sim.outcome(task(n))).toBe("done");
    expect(sim.mostAgentsAtOnce).toBe(2);
  });

  test("survives a restart halfway, and finishes every task", () => {
    const sim = new Simulator(config);
    for (const n of [1, 2, 3]) sim.add(task(n));
    sim.run({ steps: 12 });
    sim.restart();
    sim.run();

    for (const n of [1, 2, 3]) expect(sim.outcome(task(n))).toBe("done");
  });
});

describe("a command sent again after a restart", () => {
  test("gets the same reply, as a real tool must give", () => {
    const sim = new Simulator(config);
    sim.add(task(1), { conflicts: 1 });
    for (let step = 0; step < 200 && sim.outcome(task(1)) === null; step++) {
      sim.run({ steps: 1 });
      sim.restart();
    }

    expect(sim.outcome(task(1))).toBe("done");
    expect(sim.events(task(1)).filter((type) => type === "main.conflict")).toHaveLength(1);
  });
});

describe("a builder that asks", () => {
  test("waits for your answer, then carries on to done", () => {
    const sim = new Simulator(config);
    sim.add(task(1), { asks: 1 });
    sim.run();

    expect(sim.outcome(task(1))).toBeNull();
    expect(sim.waitingForYou()).toEqual([task(1)]);

    sim.settle();
    expect(sim.outcome(task(1))).toBe("done");
  });

  // An agent waiting on you holds no slot, so another task can start.
  test("frees its slot while it waits", () => {
    const sim = new Simulator({ ...config, maxRunning: 1 });
    sim.add(task(1), { asks: 1 });
    sim.add(task(2));
    sim.run();

    expect(sim.outcome(task(2))).toBe("done");
    expect(sim.mostAgentsAtOnce).toBe(1);
  });
});
