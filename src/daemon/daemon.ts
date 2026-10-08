// `skel serve`: one daemon for one repository. It reads skelcrew.yaml, takes
// the repository's lock, opens the store, reopens the loop from it, and
// answers requests on a local socket until it is stopped.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { readConfig } from "../config/config";
import { Loop, type Tools } from "../loop/loop";
import { FakeTools } from "../sim/fakes";
import { EventStore } from "../store/store";
import { answerLine } from "./handle";
import { takeLock } from "./lock";
import { daemonPaths, ownSocketFolder } from "./paths";
import { listen } from "./server";

export type Daemon = {
  socket: string;
  // Stops listening, closes the store and lets go of the lock.
  stop(): Promise<void>;
};

export type ServeOptions = {
  // Replaces the folder in /tmp for a long repository path's socket, so
  // tests never touch a real user's folder.
  socketFolder?: string;
  // The fake tools unless given. The real ones come in milestone 4.
  tools?: Tools;
  now?: () => number;
  // How often the daemon retries replies it couldn't save and starts what
  // the scheduler picks. A second unless set.
  tickMs?: number;
};

export type Served = { ok: true; daemon: Daemon } | { ok: false; message: string };

// The fake tools, as the daemon's. Each reply comes back a moment later,
// never from inside carryOut.
function fakeTools(): Tools {
  const fakes = new FakeTools();
  return { carryOut: (command, reply) => setTimeout(() => reply(fakes.answer(command)), 0) };
}

export async function serve(repo: string, options: ServeOptions = {}): Promise<Served> {
  const found = daemonPaths(repo, options.socketFolder);
  if (!found.ok) return found;
  const paths = found.paths;

  const text = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  const read = readConfig(text);
  if (!read.ok) return { ok: false, message: `skelcrew.yaml: ${read.reasons.join("; ")}` };

  mkdirSync(paths.folder, { recursive: true });
  const locked = takeLock(paths.repo);
  if (!locked.ok) return locked;
  const lock = locked.lock;
  // Everything after the lock lets go of it on the way out if it fails.
  const fail = (message: string): Served => {
    lock.release();
    return { ok: false, message };
  };

  if (paths.sharedSocketFolder !== null) {
    const refused = ownSocketFolder(paths.sharedSocketFolder);
    if (refused !== null) return fail(refused);
  }
  // Holding the lock means no other daemon runs here, so a socket file still
  // there was left by one that died.
  rmSync(paths.socket, { force: true });

  let store: EventStore;
  try {
    store = EventStore.open(paths.store);
  } catch (error) {
    return fail(`.skelcrew/skelcrew.db couldn't be opened: ${String(error)}`);
  }
  const opened = Loop.open(read.settings.config, options.tools ?? fakeTools(), store, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!opened.ok) {
    store.close();
    return fail(`.skelcrew/skelcrew.db can't be read back. ${opened.reason}`);
  }
  const loop = opened.loop;

  const listening = await listen(paths.socket, (line) => answerLine(loop, line));
  // Each tick runs between requests, never during one, since both run on
  // this one thread and neither waits.
  const ticking = setInterval(() => {
    loop.retryReplies();
    loop.startWaiting();
  }, options.tickMs ?? 1_000);
  return {
    ok: true,
    daemon: {
      socket: paths.socket,
      stop: async () => {
        clearInterval(ticking);
        await listening.stop();
        store.close();
        rmSync(paths.socket, { force: true });
        lock.release();
      },
    },
  };
}
