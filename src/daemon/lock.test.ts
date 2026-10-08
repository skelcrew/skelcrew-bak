import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALREADY_RUNNING, type Lock, takeLock } from "./lock";
import { cleanUp, folder } from "./testing";

const held: Lock[] = [];
afterEach(() => {
  for (const lock of held.splice(0)) lock.release();
  cleanUp();
});

function take(repo: string) {
  const taken = takeLock(repo);
  if (taken.ok) held.push(taken.lock);
  return taken;
}

// A repository folder with its .skelcrew folder, as the daemon makes it.
function repo(): string {
  const dir = folder();
  mkdirSync(join(dir, ".skelcrew"));
  return dir;
}

// Starts `count` processes at once, each trying to take the lock on `dir`.
// Each says GOT or NO, then holds on until all have said, so the one that got
// it still holds it while the others try. Returns how many got it.
async function race(dir: string, count: number): Promise<number> {
  const script = join(folder(), "race.ts");
  writeFileSync(
    script,
    `import { takeLock } from ${JSON.stringify(join(import.meta.dir, "lock.ts"))};\n` +
      "const taken = takeLock(process.argv[2] ?? '');\n" +
      "console.log(taken.ok ? 'GOT' : 'NO');\n" +
      "for await (const _ of console) break;\n",
  );
  const children = Array.from({ length: count }, () =>
    Bun.spawn([process.execPath, script, dir], { stdin: "pipe", stdout: "pipe" }),
  );
  const said = await Promise.all(
    children.map(async (child) => {
      const reader = child.stdout.getReader();
      let text = "";
      while (!text.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      return text.trim();
    }),
  );
  for (const child of children) child.stdin.end();
  await Promise.all(children.map((child) => child.exited));
  return said.filter((word) => word === "GOT").length;
}

describe("one daemon per repository", () => {
  test("refuses a second lock on the same repository", () => {
    const dir = repo();
    take(dir);

    const second = take(dir);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.message).toStartWith(ALREADY_RUNNING);
  });

  test("names the process that holds it, and frees it on release", () => {
    const dir = repo();
    const first = take(dir);

    const refused = takeLock(dir);
    expect(!refused.ok && refused.message).toContain(`as process ${process.pid}`);

    if (first.ok) first.lock.release();
    expect(take(dir).ok).toBe(true);
  });

  // The lock is on the repository's folder, not on a file inside it, so
  // replacing .skelcrew can't let a second daemon onto the same log.
  test("still refuses after .skelcrew is deleted or replaced", () => {
    const dir = repo();
    take(dir);

    rmSync(join(dir, ".skelcrew"), { recursive: true });
    expect(take(dir).ok).toBe(false);
    mkdirSync(join(dir, "elsewhere"));
    renameSync(join(dir, "elsewhere"), join(dir, ".skelcrew"));
    expect(take(dir).ok).toBe(false);
  });

  test("lets exactly one of several processes starting at once take it", async () => {
    expect(await race(repo(), 6)).toBe(1);
  }, 30_000);

  // The operating system lets go of the lock when its process ends, however
  // it ends. No process id is trusted.
  test("is free again once the process that held it has ended", async () => {
    const dir = repo();
    expect(await race(dir, 1)).toBe(1);

    expect(take(dir).ok).toBe(true);
  }, 30_000);

  test("isn't kept out by a leftover pid file", () => {
    const dir = repo();
    writeFileSync(join(dir, ".skelcrew", "daemon.pid"), "1\n");

    expect(take(dir).ok).toBe(true);
  });
});
