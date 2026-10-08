// Runs the tests with a time limit from outside. `bun run test` starts
// here. A test run can hang with no end, as Bun did in v3: it spun at full
// CPU, and no timer inside it ever fired, not even Bun's own per-test
// limit. A separate process isn't stuck with it, so it can stop the run,
// and everything the run started.
//
// The limit is SKELCREW_TEST_MINUTES, 6 when it isn't set.

import { spawn } from "node:child_process";
import * as z from "zod";

export type Run = { kind: "exited"; code: number } | { kind: "timed_out" };

// Runs the command in a process group of its own, with the terminal's input
// and output. Past `limitMs`, it asks the whole group to stop, then forces
// it after `graceMs`.
export function runWithLimit(command: string[], limitMs: number, graceMs = 2_000): Promise<Run> {
  const [program, ...args] = command;
  if (program === undefined) return Promise.resolve({ kind: "exited", code: 1 });
  return new Promise((resolve) => {
    const child = spawn(program, args, { stdio: "inherit", detached: true });
    // The run has a group of its own, so Ctrl-C in the terminal reaches
    // only this process. It is passed on, so the run stops too.
    const passOn = (signal: "SIGINT" | "SIGTERM") => () => stopGroup(child.pid, signal);
    const onInterrupt = passOn("SIGINT");
    const onTerminate = passOn("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    let timedOut = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const limit = setTimeout(() => {
      timedOut = true;
      stopGroup(child.pid, "SIGTERM");
      force = setTimeout(() => stopGroup(child.pid, "SIGKILL"), graceMs);
    }, limitMs);
    child.on("error", () => {
      clearTimeout(limit);
      resolve({ kind: "exited", code: 1 });
    });
    child.on("exit", (code) => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      clearTimeout(limit);
      clearTimeout(force);
      // Anything the run left behind in its group goes too.
      stopGroup(child.pid, "SIGKILL");
      resolve(timedOut ? { kind: "timed_out" } : { kind: "exited", code: code ?? 1 });
    });
  });
}

// A negative process ID means the whole group. A group already gone is
// left alone.
function stopGroup(pid: number | undefined, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void {
  if (pid === undefined || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

if (import.meta.main) {
  const minutes = z.coerce
    .number()
    .positive()
    .catch(6)
    .parse(process.env.SKELCREW_TEST_MINUTES ?? 6);
  const limitMs = minutes * 60_000;
  const run = await runWithLimit(["bun", "test", ...process.argv.slice(2)], limitMs);
  if (run.kind === "timed_out") {
    console.error(
      `The tests ran for more than ${limitMs / 60_000} minutes, so they were stopped. They likely hung.`,
    );
    process.exit(1);
  }
  process.exit(run.code);
}
