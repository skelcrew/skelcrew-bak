// Helpers for the daemon's tests: throwaway folders, cleaned up after each
// test.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

// A new empty folder, by its real path, removed by cleanUp.
export function folder(prefix = "sk-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

export function cleanUp(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}
