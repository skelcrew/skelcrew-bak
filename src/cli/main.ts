#!/usr/bin/env bun
// The `skel` command. `skel serve` runs the daemon for the repository in the
// current folder. Every other command goes to that daemon, starting it first
// if none runs.

import { mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sendStarting } from "../daemon/client";
import { serve } from "../daemon/daemon";
import { daemonPaths, findRepo, ownSocketFolder } from "../daemon/paths";
import { run } from "./cli";

const args = Bun.argv.slice(2);
// The repository this command belongs to, from whichever folder in it.
const repo = findRepo(process.cwd());

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
    send: (call, token) => sendStarting(paths.socket, call, token, () => start(paths.folder)),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  process.exit(code);
}

// Starts `skel serve` in a process of its own, which carries on after this
// command ends. What it prints goes to .skelcrew/daemon.log. Returns a check
// that says why it stopped, from the log's last line, or null while it runs.
async function start(folder: string): Promise<() => string | null> {
  mkdirSync(folder, { recursive: true });
  const logPath = join(folder, "daemon.log");
  const log = openSync(logPath, "a");
  const daemon = Bun.spawn([process.execPath, import.meta.path, "serve"], {
    cwd: repo,
    stdin: "ignore",
    stdout: log,
    stderr: log,
  });
  daemon.unref();
  return () => {
    if (daemon.exitCode === null) return null;
    const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
    return lines[lines.length - 1] ?? `it exited with code ${daemon.exitCode}`;
  };
}
