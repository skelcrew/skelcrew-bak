// `skel serve`: one daemon for one repository. It reads skelcrew.yaml, takes
// the repository's lock, opens the store, reopens the loop from it, and
// answers requests on a local socket until it is stopped.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../config/config";
import type { SessionId } from "../core/ids";
import type { BranchFacts, Task } from "../core/types";
import { Loop, type Tools } from "../loop/loop";
import { FakeTools } from "../sim/fakes";
import { EventStore } from "../store/store";
import { answerLine } from "./handle";
import { takeLock } from "./lock";
import { daemonPaths, ownSocketFolder } from "./paths";
import { listen } from "./server";
import { loadSecret, Tokens } from "./tokens";

export type Daemon = {
  socket: string;
  // The token a session gets in SKELCREW_SESSION.
  tokenFor(session: SessionId): string;
  // Stops listening, closes the store and lets go of the lock.
  stop(): Promise<void>;
};

export type ServeOptions = {
  // Replaces the folder in /tmp for a long repository path's socket, so
  // tests never touch a real user's folder.
  socketFolder?: string;
  // The fake tools unless given. The real ones come in milestone 4.
  tools?: Tools;
  // What git says about a task's branch, added to an agent's done. The
  // fakes' unless given.
  branchOf?: (task: Task) => BranchFacts;
  now?: () => number;
  // How often the daemon retries replies it couldn't save and starts what
  // the scheduler picks. A second unless set.
  tickMs?: number;
};

export type Served = { ok: true; daemon: Daemon } | { ok: false; message: string };

// The fake tools, as the daemon's. Each reply comes back a moment later,
// never from inside carryOut.
//
// A fake session has no environment to hold its token, so the fake runner
// writes the task's latest token to .skelcrew/sessions/<task>. You stand in
// for its agent with SKELCREW_SESSION=$(cat .skelcrew/sessions/1). This goes
// with the fakes in milestone 4.
function fakeTools(fakes: FakeTools, tokens: Tokens, sessions: string): Tools {
  return {
    carryOut: (command, reply) => {
      const answer = fakes.answer(command);
      if (answer?.type === "session_started" && command.type === "start_session") {
        mkdirSync(sessions, { recursive: true });
        writeFileSync(join(sessions, `${command.taskId}`), `${tokens.tokenFor(answer.session)}\n`);
      }
      setTimeout(() => {
        try {
          reply(answer);
        } catch (error) {
          // A reply that doesn't fit its command. Its command stays in the
          // outbox, and goes out again at the next start.
          console.error(
            `A tool's reply failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }, 0);
    },
  };
}

export async function serve(repo: string, options: ServeOptions = {}): Promise<Served> {
  const found = daemonPaths(repo, options.socketFolder);
  if (!found.ok) return found;
  const paths = found.paths;

  const text = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  const read = readConfig(text);
  if (!read.ok) return { ok: false, message: `skelcrew.yaml: ${read.reasons.join("; ")}` };
  const config = read.settings.config;

  // What has been taken so far, let go of in reverse if a later step fails,
  // so a failed start never keeps the lock or the store.
  const undo: (() => void)[] = [];
  const letGo = () => {
    for (const step of undo.reverse()) step();
  };
  try {
    // The socket lives here, so only this user may reach in, from before it
    // exists.
    mkdirSync(paths.folder, { recursive: true, mode: 0o700 });
    chmodSync(paths.folder, 0o700);
    // Nothing in it belongs in git, least of all the secret that signs every
    // session token. This holds in any repository, whatever its .gitignore.
    writeFileSync(join(paths.folder, ".gitignore"), "*\n");

    const locked = takeLock(paths.repo);
    if (!locked.ok) return locked;
    undo.push(() => locked.lock.release());
    if (paths.sharedSocketFolder !== null) {
      const refused = ownSocketFolder(paths.sharedSocketFolder);
      if (refused !== null) {
        letGo();
        return { ok: false, message: refused };
      }
    }
    // Holding the lock means no other daemon runs here, so a socket file
    // still there was left by one that died.
    rmSync(paths.socket, { force: true });

    const store = EventStore.open(paths.store);
    undo.push(() => store.close());
    const fakes = new FakeTools();
    const tokens = new Tokens(loadSecret(join(paths.folder, "secret")));
    const tools = options.tools ?? fakeTools(fakes, tokens, join(paths.folder, "sessions"));
    const opened = Loop.open(config, tools, store, {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (!opened.ok) {
      letGo();
      return { ok: false, message: `.skelcrew/skelcrew.db can't be read back. ${opened.reason}` };
    }
    const loop = opened.loop;

    const context = { loop, tokens, branchOf: options.branchOf ?? (() => fakes.branch()) };
    const listening = await listen(paths.socket, (line) => answerLine(context, line));
    undo.push(() => rmSync(paths.socket, { force: true }));
    // Each tick runs between requests, never during one, since both run on
    // this one thread and neither waits.
    // A failure in one is logged, and the next tick tries again.
    const ticking = setInterval(() => {
      try {
        loop.retryReplies();
        loop.startWaiting();
      } catch (error) {
        console.error(`A tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, options.tickMs ?? 1_000);
    return {
      ok: true,
      daemon: {
        socket: paths.socket,
        tokenFor: (session) => tokens.tokenFor(session),
        stop: async () => {
          clearInterval(ticking);
          await listening.stop();
          letGo();
        },
      },
    };
  } catch (error) {
    letGo();
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `The daemon couldn't start: ${reason}` };
  }
}
