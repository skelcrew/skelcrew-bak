import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonPaths, findRepo, ownSocketFolder } from "./paths";
import { cleanUp, folder } from "./testing";

afterEach(cleanUp);

function paths(repo: string, socketFolder?: string) {
  const found = daemonPaths(repo, socketFolder);
  if (!found.ok) throw new Error(found.message);
  return found.paths;
}

// A repository deep enough that a socket inside it would be too long.
function deep(): string {
  const repo = join(folder(), "a-folder-with-a-rather-long-name".repeat(3));
  mkdirSync(repo);
  return repo;
}

describe("where a repository's daemon keeps its files", () => {
  test("is .skelcrew/ in the repository, with the config at its root", () => {
    const repo = folder();

    expect(paths(repo)).toEqual({
      repo,
      folder: join(repo, ".skelcrew"),
      config: join(repo, "skelcrew.yaml"),
      store: join(repo, ".skelcrew", "skelcrew.db"),
      socket: join(repo, ".skelcrew", "daemon.sock"),
      sharedSocketFolder: null,
    });
  });

  // macOS refuses a socket path over 103 bytes.
  test("puts the socket in a short folder of its own when the repository's path is long", () => {
    const own = join(folder(), "sockets");
    const found = paths(deep(), own);

    expect(found.sharedSocketFolder).toBe(own);
    expect(found.socket.startsWith(`${own}/`)).toBe(true);
  });

  test("defaults that folder to one in /tmp for this user, whatever TMPDIR says", () => {
    const repo = deep();
    const before = process.env.TMPDIR;
    try {
      process.env.TMPDIR = folder();
      const socket = paths(repo).socket;
      process.env.TMPDIR = folder();

      expect(paths(repo).socket).toBe(socket);
      expect(socket.startsWith(`/tmp/skelcrew-${process.getuid?.()}/`)).toBe(true);
      expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
  });

  test("gives two long repositories different sockets", () => {
    const own = join(folder(), "sockets");

    expect(paths(deep(), own).socket).not.toBe(paths(deep(), own).socket);
  });

  // `skel` may find the repository through a link, and the daemon through its
  // real path. Both must reach the same socket.
  test("are the same for a repository reached through a link", () => {
    const repo = deep();
    const link = join(folder(), "link");
    symlinkSync(repo, link);

    expect(paths(link)).toEqual(paths(repo));
  });

  test("can't be found for a folder that doesn't exist", () => {
    const missing = join(folder(), "missing");

    expect(daemonPaths(missing)).toEqual({
      ok: false,
      message: `The folder ${missing} doesn't exist.`,
    });
  });
});

describe("the shared socket folder", () => {
  test("is made for this user alone", () => {
    const path = join(folder(), "sockets");

    expect(ownSocketFolder(path)).toBeNull();
    expect(ownSocketFolder(path)).toBeNull();
  });

  test("is refused when something that isn't a folder is in its place", () => {
    const path = join(folder(), "sockets");
    writeFileSync(path, "");

    expect(ownSocketFolder(path)).toBe(
      `${path} isn't a folder, so skelcrew won't use it. Remove it, then try again.`,
    );
  });
});

describe("the repository a skel command belongs to", () => {
  test("is the nearest folder above with a .skelcrew folder", () => {
    const repo = folder();
    mkdirSync(join(repo, ".skelcrew"));
    mkdirSync(join(repo, "src", "deep"), { recursive: true });

    expect(findRepo(join(repo, "src", "deep"))).toBe(repo);
  });

  // An agent runs skel from its worktree, which lives inside the repository's
  // .skelcrew, and has a .git of its own.
  test("is the main repository, from inside a task's worktree", () => {
    const repo = folder();
    const worktree = join(repo, ".skelcrew", "worktrees", "1-fix", "src");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repo, ".skelcrew", "worktrees", "1-fix", ".git"), "gitdir: ...\n");
    // Where the agent writes the files it hands over.
    mkdirSync(join(repo, ".skelcrew", "worktrees", "1-fix", ".skelcrew", "out"), {
      recursive: true,
    });

    expect(findRepo(worktree)).toBe(repo);
  });

  test("is the nearest folder above with skelcrew.yaml", () => {
    const repo = folder();
    writeFileSync(join(repo, "skelcrew.yaml"), "");
    mkdirSync(join(repo, "src"));

    expect(findRepo(join(repo, "src"))).toBe(repo);
  });

  test("is the git repository's top, before Skelcrew has run there", () => {
    const repo = folder();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "src"));

    expect(findRepo(join(repo, "src"))).toBe(repo);
  });

  test("is the folder itself, when nothing above says otherwise", () => {
    const here = folder();

    expect(findRepo(here)).toBe(here);
  });
});
