// Milestone 3's "done when": one task walked through its whole life with
// `skel` commands, through the real daemon and socket, with this test
// standing in for each agent by its session's token.

import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { send } from "../daemon/client";
import { type Daemon, serve } from "../daemon/daemon";
import { cleanUp, folder } from "../daemon/testing";
import type { Row } from "../protocol/protocol";
import { run } from "./cli";

const running: Daemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  cleanUp();
});

test("a task goes from skel add to delivered, with you and its agents using skel", async () => {
  const repo = folder();
  const served = await serve(repo, { socketFolder: join(folder(), "sockets"), tickMs: 10 });
  if (!served.ok) throw new Error(served.message);
  running.push(served.daemon);
  const socket = served.daemon.socket;

  // The files the agents hand over.
  const files = folder();
  for (const [name, text] of Object.entries({
    "brief.md": "Skip empty header rows when exporting.",
    "summary.md": "Empty header rows are skipped.",
    "evidence.md": "bun test passes, and an export with an empty header row works.",
  })) {
    writeFileSync(join(files, name), text);
  }

  // `skel`, as you, or as the agent working on task 1 now.
  const said: string[] = [];
  const skel = async (args: string[], as: "you" | "agent" = "you") => {
    const env: Record<string, string> = {};
    if (as === "agent") {
      env.SKELCREW_SESSION = readFileSync(join(repo, ".skelcrew", "sessions", "1"), "utf8").trim();
    }
    let failed = "";
    const code = await run(args, {
      env,
      send: (call, token) => send(socket, call, token),
      out: (line) => said.push(line),
      err: (line) => {
        failed = line;
      },
    });
    expect(failed).toBe("");
    expect(code).toBe(0);
  };
  const task = async (): Promise<Row | undefined> => {
    const listed = await send(socket, { type: "ls" });
    return listed.ok && listed.result.kind === "tasks" ? listed.result.tasks[0] : undefined;
  };
  const waitFor = async (phase: Row["phase"], state: string) => {
    for (let waited = 0; waited < 2_000; waited += 5) {
      const row = await task();
      if (row?.phase === phase && row.state === state) return;
      await Bun.sleep(5);
    }
    expect(await task()).toMatchObject({ phase, state });
  };

  await skel(["add", "Fix the export"]);
  await waitFor("triage", "running");

  await skel(
    [
      "triage",
      "proceed",
      "--intent",
      "ship",
      "--rigor",
      "light",
      "--brief",
      join(files, "brief.md"),
    ],
    "agent",
  );
  await waitFor("build", "running");

  await skel(["progress", "Found the cause: the header row is skipped when empty."], "agent");
  await skel(
    ["ask", "Keep the old export format too?", "--option", "yes", "--option", "no"],
    "agent",
  );
  expect(await task()).toMatchObject({ state: "waiting for your answer" });
  // Your answer is kept, then typed into the builder's session once it has a
  // slot again.
  await skel(["reply", "1", "yes"]);
  await waitFor("build", "running");

  await skel(["done", "--summary", join(files, "summary.md")], "agent");
  await waitFor("review", "running");

  await skel(["pass", "--evidence", join(files, "evidence.md")], "agent");
  await waitFor("ended", "done");

  expect(said).toEqual([
    "Added #1.",
    "Sent to #1.", // triage proceed
    "Sent to #1.", // progress
    "Sent to #1.", // ask
    "Replied to #1.",
    "Sent to #1.", // done
    "Sent to #1.", // pass
  ]);
});
