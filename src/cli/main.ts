#!/usr/bin/env bun
// The `skel` command. `skel serve` runs the daemon for the repository in the
// current folder. Every other command goes to that daemon.

import { send } from "../daemon/client";
import { serve } from "../daemon/daemon";
import { daemonPaths } from "../daemon/paths";
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
  const code = await run(args, {
    env: process.env,
    send: (call, token) => send(found.paths.socket, call, token),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  process.exit(code);
}
