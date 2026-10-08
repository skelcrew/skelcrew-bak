// Where a repository's daemon keeps its files. The daemon and the client
// both ask here, so they always agree on the socket.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, type Stats, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type DaemonPaths = {
  // The repository's real path. The daemon locks this folder.
  repo: string;
  folder: string;
  config: string; // skelcrew.yaml, at the repository's root
  store: string;
  socket: string;
  // Where the socket goes when it can't go in .skelcrew/: a folder in /tmp
  // for this user alone, which the daemon makes. Null when it fits.
  sharedSocketFolder: string | null;
};

// macOS refuses a socket path longer than this. Linux allows 107.
const MAX_SOCKET_PATH = 103;

// Paths start from the repository's real path, so a repository reached
// through a link gets the same socket as the daemon sees. `socketFolder`
// replaces the folder in /tmp. Tests give their own, so they never touch a
// real user's folder.
export function daemonPaths(
  repo: string,
  socketFolder = `/tmp/skelcrew-${process.getuid?.() ?? "user"}`,
): { ok: true; paths: DaemonPaths } | { ok: false; message: string } {
  let real: string;
  try {
    real = realpathSync(repo);
  } catch {
    return { ok: false, message: `The folder ${repo} doesn't exist.` };
  }
  const folder = join(real, ".skelcrew");
  // A hash of the real path names things kept outside the repository. It
  // holds only lowercase letters and digits, whatever the path holds.
  const hash = createHash("sha256").update(real).digest("hex");
  let socket = join(folder, "daemon.sock");
  let sharedSocketFolder: string | null = null;
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
    // A fixed folder, not the temp folder, which can differ between two
    // shells of the same user. The user id keeps users apart.
    sharedSocketFolder = socketFolder;
    socket = join(sharedSocketFolder, `${hash.slice(0, 16)}.sock`);
  }
  return {
    ok: true,
    paths: {
      repo: real,
      folder,
      config: join(real, "skelcrew.yaml"),
      store: join(folder, "skelcrew.db"),
      socket,
      sharedSocketFolder,
    },
  };
}

// Makes the socket folder in /tmp if it isn't there, for this user alone.
// Then says why it can't be trusted, or null if it can. It must be a real
// folder that belongs to this user. Otherwise its owner could put their
// own socket there, and answer in the daemon's place. Once it is the
// user's own, nobody else can put anything in it, or move it away.
export function ownSocketFolder(path: string): string | null {
  try {
    mkdirSync(path, { mode: 0o700, recursive: true });
  } catch {
    // Something else is at the path. What it is decides the answer.
  }
  let found: Stats;
  try {
    found = lstatSync(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `${path} couldn't be made for the daemon's socket: ${reason}`;
  }
  const mine = found.uid === process.getuid?.();
  if (mine && found.isDirectory()) return null;
  if (mine) return `${path} isn't a folder, so skelcrew won't use it. Remove it, then try again.`;
  return `${path} belongs to another user, so skelcrew won't use it. An administrator must remove it.`;
}

// The repository a `skel` command run in `here` belongs to, so every command
// in it reaches the same daemon, from any folder. A task's worktree lives in
// the repository's .skelcrew, so a path through a .skelcrew folder belongs to
// the folder holding the first one, even though the worktree has a .git and a
// .skelcrew of its own. Otherwise it is the nearest folder above with a
// .skelcrew folder or skelcrew.yaml, then the nearest with a .git, then
// `here` itself.
export function findRepo(here: string): string {
  const parts = resolve(here).split(sep);
  const inside = parts.indexOf(".skelcrew");
  if (inside > 0) return parts.slice(0, inside).join(sep) || sep;

  const above = (has: (dir: string) => boolean): string | null => {
    for (let dir = resolve(here); ; dir = dirname(dir)) {
      if (has(dir)) return dir;
      if (dirname(dir) === dir) return null;
    }
  };
  return (
    above((dir) => isFolder(join(dir, ".skelcrew")) || existsSync(join(dir, "skelcrew.yaml"))) ??
    above((dir) => existsSync(join(dir, ".git"))) ??
    resolve(here)
  );
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
