// The loop's property test: several tasks through the real loop and store,
// with replies from different tasks interleaved at random, saves that fail
// at random, restarts at random moments, and your pauses, kills, retries
// and answers at random, so tools' replies also arrive late. The numbers in the comments
// match the rules in docs/invariants.md tagged (loop).

import { expect, test } from "bun:test";
import * as fc from "fast-check";
import { TaskId } from "../core/ids";
import { config } from "../core/testing";
import { Simulator } from "../sim/simulator";

const tasks = [1, 2, 3, 4].map((n) => TaskId.parse(n));

test("the loop keeps its rules through failed saves, restarts and your inputs", () => {
  fc.assert(
    fc.property(
      fc.integer(),
      fc.array(fc.boolean(), { minLength: 20, maxLength: 120 }),
      // Changes asked for per task, below the loop cap of 3, so each finishes.
      fc.array(fc.nat(1), { minLength: 4, maxLength: 4 }),
      // Questions each task's builder asks you.
      fc.array(fc.nat(2), { minLength: 4, maxLength: 4 }),
      (seed, restarts, changes, asks) => {
        const sim = new Simulator(
          { ...config, maxRunning: 2 },
          { seed, failSaves: 0.15, yourInputs: 0.1 },
        );
        for (const [i, taskId] of tasks.entries()) {
          sim.add(taskId, { changes: changes[i] ?? 0, asks: asks[i] ?? 0 });
        }

        for (const restart of restarts) {
          // 17: a failed save changes nothing. The simulator checks it on
          // every input it sends.
          sim.run({ steps: 1 });
          if (restart) sim.restart();

          // 10: never more than max_running agents at work.
          expect(sim.mostAgentsAtOnce).toBeLessThanOrEqual(2);
          // 22: the loop's tasks match a fresh replay of the saved log.
          expect(sim.tasksMatchTheLog()).toBe(true);
        }

        // 16: every saved command is carried out once the daemon runs, so
        // every task still ends once you answer, resume and retry what waits
        // on you. A kill ends one early.
        sim.settle();
        for (const taskId of tasks) expect(sim.outcome(taskId)).not.toBeNull();
        expect(sim.mostAgentsAtOnce).toBeLessThanOrEqual(2);
        expect(sim.tasksMatchTheLog()).toBe(true);
      },
    ),
    { numRuns: 150 },
  );
}, 60_000); // each run goes through a real SQLite store
