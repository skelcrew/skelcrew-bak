import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Socket as NodeSocket } from "node:net";
import { join } from "node:path";
import { MAX_LINE } from "../protocol/protocol";
import { send, sendStarting } from "./client";
import { type Daemon, serve } from "./daemon";
import { ALREADY_RUNNING } from "./lock";
import { daemonPaths } from "./paths";
import { cleanUp, folder } from "./testing";

const running: Daemon[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const close of closers.splice(0)) close();
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
    return () => null;
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

  test("says at once why a started daemon stopped", async () => {
    const repo = repository();
    const began = Date.now();

    const sent = await sendStarting(
      repo.socket,
      { type: "ls" },
      null,
      async () => () => "skelcrew.yaml: limits.max_running: expected a number, got string",
    );
    expect(sent).toEqual({
      ok: false,
      message:
        "The daemon stopped while starting: skelcrew.yaml: limits.max_running: expected a number, got string",
    });
    expect(Date.now() - began).toBeLessThan(1_000);
  });

  // Two commands can each start one. The second stops on the lock, and both
  // reach the first.
  test("keeps waiting when the daemon it started found another running", async () => {
    const repo = repository();

    const sent = await sendStarting(repo.socket, { type: "ls" }, null, async () => {
      await repo.start();
      return () => `${ALREADY_RUNNING}, as process 1.`;
    });
    expect(sent.ok).toBe(true);
  });

  test("gives up when a started daemon never answers, saying where to look", async () => {
    const repo = repository();

    const sent = await sendStarting(repo.socket, { type: "ls" }, null, async () => () => null, 200);
    expect(sent).toEqual({
      ok: false,
      message:
        "The daemon didn't answer within 0.2 seconds of starting it. See .skelcrew/daemon.log.",
    });
  });
});

describe("a daemon that misbehaves", () => {
  // A server on its own socket that does `behave` with every connection.
  async function server(behave: (connection: NodeSocket) => void): Promise<string> {
    const socket = join(folder(), "odd.sock");
    const listening = createServer(behave);
    await new Promise<void>((resolve) => listening.listen(socket, resolve));
    closers.push(() => listening.close());
    return socket;
  }

  test("that never answers is given up on, saying so", async () => {
    const socket = await server(() => {});

    expect(await send(socket, { type: "ls" }, null, 200)).toEqual({
      ok: false,
      message: "The daemon didn't answer within 0.2 seconds.",
    });
  });

  test("that sends a line longer than the limit is refused", async () => {
    const socket = await server((connection) => connection.write("x".repeat(MAX_LINE + 10)));

    expect(await send(socket, { type: "ls" })).toEqual({
      ok: false,
      message: `The answer is longer than ${MAX_LINE} bytes.`,
    });
  });
});
