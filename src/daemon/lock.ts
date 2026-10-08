// One daemon per repository. The daemon takes an exclusive `flock` on the
// repository's folder and keeps it for as long as it runs. The operating
// system keeps that lock for the daemon's process and lets go of it the
// moment the process ends, however it ends. So:
//
// - a second daemon is refused at once, even if several start together;
//   `flock` either gets the lock or it doesn't, in one step;
// - a daemon that crashed never keeps the next one out;
// - no process id is ever trusted, so a reused one can't block a start;
// - it works the same on a folder the daemon can't write to;
// - deleting or replacing .skelcrew, or anything in it, can't let a second
//   daemon in. A lock on something inside the repository could: the next
//   daemon would lock the replacement, and two daemons would then share
//   one database.
//
// The lock is taken through the system's C library, since Bun has no
// `flock` of its own. It is the same on macOS and Linux. Windows has no
// `flock` (it has LockFileEx), and the rest of the daemon assumes Unix too,
// so there the lock refuses plainly.
//
// The daemon's process id is written to .skelcrew/daemon.pid, only to say
// who runs it.

import { dlopen, FFIType, read } from "bun:ffi";
import { closeSync, constants, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Lock = { release(): void };

// How a refusal because another daemon holds the lock begins. The client
// looks for it: the other daemon may be on its way out.
export const ALREADY_RUNNING = "The daemon is already running for this repository";

export type Locked = { ok: true; lock: Lock } | { ok: false; message: string };

// From <sys/file.h>: an exclusive lock, and don't wait for it.
const LOCK_EX = 2;
const LOCK_NB = 4;

// `repo` is the repository's folder.
export function takeLock(repo: string, pid = process.pid): Locked {
  const system = libc();
  if (!system.ok) return { ok: false, message: couldNot(system.reason) };

  // Opened read-only, since a folder can't be opened any other way.
  // Close-on-exec, so no process the daemon starts, such as git or the
  // checks, is handed the folder and could keep the lock after the daemon
  // has died. Bun's spawn happens to leave it out anyway on macOS. The flag
  // makes that true however a process is started.
  let fd: number;
  try {
    fd = openSync(repo, constants.O_RDONLY | system.value.closeOnExec);
  } catch (error) {
    return { ok: false, message: couldNot(describe(error)) };
  }

  const pidFile = join(repo, ".skelcrew", "daemon.pid");
  if (system.value.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    const errno = system.value.errno();
    closeSync(fd);
    if (errno === system.value.wouldBlock) {
      const holder = readPid(pidFile);
      // A daemon nobody can reach, say because its socket file was deleted,
      // still holds the lock. So say how to get past it.
      const message =
        holder === null
          ? `${ALREADY_RUNNING}. If skelcrew can't reach it, stop the daemon and try again.`
          : `${ALREADY_RUNNING}, as process ${holder}. If skelcrew can't reach it, stop that process and try again.`;
      return { ok: false, message };
    }
    return { ok: false, message: couldNot(`the system refused it, with error ${errno}`) };
  }

  try {
    writeFileSync(pidFile, `${pid}\n`);
  } catch {
    // Only used to say who runs the daemon.
  }
  let released = false;
  return {
    ok: true,
    lock: {
      // Never throws. The lock is let go of first, by closing the file, so
      // nothing that fails after, such as removing daemon.pid from a folder
      // that became read-only, can keep it held.
      release: () => {
        if (released) return;
        released = true;
        try {
          closeSync(fd);
        } catch {
          // Already closed: the lock is gone either way.
        }
        try {
          if (readPid(pidFile) === pid) rmSync(pidFile, { force: true });
        } catch {
          // Only used to say who runs the daemon. The next daemon overwrites it.
        }
      },
    },
  };
}

type Libc = {
  flock(fd: number, operation: number): number;
  errno(): number;
  // The error `flock` gives when another process holds the lock.
  wouldBlock: number;
  // The `open` flag for close-on-exec. Bun's fs.constants lacks it.
  closeOnExec: number;
};

let loaded: { ok: true; value: Libc } | { ok: false; reason: string } | null = null;

// The C library's `flock`, and a way to read why it failed. Both differ by
// name between macOS and Linux.
function libc(): { ok: true; value: Libc } | { ok: false; reason: string } {
  if (loaded !== null) return loaded;
  // Values from each system's headers. On Linux, glibc's library name is
  // tried first. On musl (Alpine and the like) that name loads musl too,
  // and its own name is a fallback.
  const found =
    process.platform === "darwin"
      ? {
          libraries: ["libSystem.B.dylib"],
          errnoAt: "__error",
          wouldBlock: 35,
          closeOnExec: 0x1000000,
        }
      : process.platform === "linux"
        ? {
            libraries: ["libc.so.6", `ld-musl-${muslArch()}.so.1`],
            errnoAt: "__errno_location",
            wouldBlock: 11,
            closeOnExec: 0o2000000,
          }
        : null;
  if (found === null) {
    loaded = { ok: false, reason: `Skelcrew's daemon doesn't run on ${process.platform} yet.` };
    return loaded;
  }
  const failures: string[] = [];
  for (const library of found.libraries) {
    const opened = openLibrary(library, found.errnoAt, found.wouldBlock, found.closeOnExec);
    if (opened.ok) {
      loaded = opened;
      return loaded;
    }
    failures.push(`${library}: ${opened.reason}`);
  }
  loaded = { ok: false, reason: `the system library couldn't be loaded (${failures.join("; ")})` };
  return loaded;
}

function openLibrary(
  library: string,
  errnoAt: string,
  wouldBlock: number,
  closeOnExec: number,
): { ok: true; value: Libc } | { ok: false; reason: string } {
  try {
    const lib = dlopen(library, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      [errnoAt]: { args: [], returns: FFIType.ptr },
    });
    const flock = lib.symbols.flock;
    const where = lib.symbols[errnoAt];
    if (where === undefined) return { ok: false, reason: `it has no ${errnoAt}.` };
    return {
      ok: true,
      value: {
        flock: (fd, operation) => Number(flock(fd, operation)),
        errno: () => {
          const at = where();
          return typeof at === "number" && at !== 0 ? read.i32(at) : -1;
        },
        wouldBlock,
        closeOnExec,
      },
    };
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
}

function muslArch(): string {
  return process.arch === "arm64" ? "aarch64" : "x86_64";
}

function couldNot(reason: string): string {
  return `The lock on the repository's folder couldn't be taken: ${reason}`;
}

function readPid(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    return /^[1-9]\d*$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
