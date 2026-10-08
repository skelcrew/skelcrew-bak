import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { send, sendStarting } from "./client";
import { type Daemon, serve } from "./daemon";
import { daemonPaths } from "./paths";
import { cleanUp, folder } from "./testing";

const running: Daemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  cleanUp();
});

// A repository, its socket, and a start that serves it here, counting starts.
function repository() {
  const repo = folder();
  const socketFolder = join(folder(), "sockets");
  const found = daemonPaths(repo, socketFolder);
  if (!found.ok) throw new Error(found.message);
  let starts = 0;
  const start = async () => {
    starts++;
    const served = await serve(repo, { socketFolder });
    if (served.ok) running.push(served.daemon);
  };
  return { socket: found.paths.socket, start, starts: () => starts };
}

describe("sending to a daemon", () => {
  test("says no daemon answers when none runs", async () => {
    const { socket } = repository();

    const sent = await send(socket, { type: "ls" });
    expect(sent.ok).toBe(false);
    expect(!sent.ok && sent.unreachable).toBe(true);
  });

  test("starts one when none answers, then sends", async () => {
    const repo = repository();

    const sent = await sendStarting(repo.socket, { type: "ls" }, null, repo.start);
    expect(sent).toEqual({ ok: true, result: { kind: "tasks", tasks: [] } });
    expect(repo.starts()).toBe(1);
  });

  test("starts none when one already answers", async () => {
    const repo = repository();
    await repo.start();

    await sendStarting(repo.socket, { type: "ls" }, null, repo.start);
    expect(repo.starts()).toBe(1);
  });

  test("gives up when a started daemon never answers, saying where to look", async () => {
    const repo = repository();

    const sent = await sendStarting(repo.socket, { type: "ls" }, null, async () => {}, 200);
    expect(sent).toEqual({
      ok: false,
      message:
        "The daemon didn't answer within 0.2 seconds of starting it. See .skelcrew/daemon.log.",
    });
  });
});
