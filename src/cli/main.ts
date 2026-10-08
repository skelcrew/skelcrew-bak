#!/usr/bin/env bun
// The `skel` command. `skel serve` runs the daemon for the repository in the
// current folder. Every other command goes to that daemon, starting it first
// if none runs.

import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { sendStarting } from "../daemon/client";
import { serve } from "../daemon/daemon";
import { daemonPaths, ownSocketFolder } from "../daemon/paths";
import { run } from "./cli";

const args = Bun.argv.slice(2);
const repo = process.cwd();

if (args[0] === "serve") {
  const served = await serve(repo);
  if (!served.ok) {
    console.error(served.message);
    process.exit(1);
  }
  console.log(`Serving ${repo}.`);
  const stop = async () => {
    await served.daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  const found = daemonPaths(repo);
  if (!found.ok) {
    console.error(found.message);
    process.exit(1);
  }
  const paths = found.paths;
  // A socket in the shared folder in /tmp is used only if the folder is this
  // user's own. Otherwise someone else's daemon could answer.
  const unsafe =
    paths.sharedSocketFolder === null ? null : ownSocketFolder(paths.sharedSocketFolder);
  if (unsafe !== null) {
    console.error(unsafe);
    process.exit(1);
  }
  const code = await run(args, {
    env: process.env,
    send: (call, token) => sendStarting(paths.socket, call, token, async () => start(paths.folder)),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  process.exit(code);
}

// Starts `skel serve` in a process of its own, which carries on after this
// command ends. What it prints goes to .skelcrew/daemon.log.
function start(folder: string): void {
  mkdirSync(folder, { recursive: true });
  const log = openSync(join(folder, "daemon.log"), "a");
  const daemon = Bun.spawn([process.execPath, import.meta.path, "serve"], {
    cwd: repo,
    stdin: "ignore",
    stdout: log,
    stderr: log,
  });
  daemon.unref();
}
