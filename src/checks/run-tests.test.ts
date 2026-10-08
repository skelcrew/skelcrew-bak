import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithLimit } from "./run-tests";

// The test runner can hang with no end, as Bun did in v3, spinning at
// full CPU. Nothing inside a hung run can stop it, so
// `bun run test` starts the tests through this, as a process of its own.

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "skelcrew-run-tests-"));
  dirs.push(dir);
  return dir;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a run that finishes in time keeps its exit code", async () => {
  expect(await runWithLimit(["sh", "-c", "exit 3"], 5_000)).toEqual({ kind: "exited", code: 3 });
  expect(await runWithLimit(["sh", "-c", "exit 0"], 5_000)).toEqual({ kind: "exited", code: 0 });
});

test("a run past its limit is stopped, with everything it started", async () => {
  const dir = folder();
  const pidFile = join(dir, "child.pid");
  const started = Date.now();
  const result = await runWithLimit(["sh", "-c", `sleep 30 & echo $! > ${pidFile}; sleep 30`], 500);
  expect(result).toEqual({ kind: "timed_out" });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(existsSync(pidFile)).toBe(true);
  const child = Number(readFileSync(pidFile, "utf8").trim());
  for (let i = 0; i < 40 && alive(child); i++) await Bun.sleep(50);
  expect(alive(child)).toBe(false);
});

test("a run that ignores the polite stop is forced", async () => {
  const result = await runWithLimit(["sh", "-c", "trap '' TERM; sleep 30"], 300, 300);
  expect(result).toEqual({ kind: "timed_out" });
});
