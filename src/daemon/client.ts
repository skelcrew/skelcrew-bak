// How `skel` talks to the daemon: one request on a fresh connection, and the
// answer that carries the same id.

import { Socket } from "node:net";
import {
  type Call,
  encode,
  MAX_LINE,
  parseAnswer,
  type Result,
  VERSION,
} from "../protocol/protocol";
import { ALREADY_RUNNING } from "./lock";

// `unreachable` says no daemon answers on the socket, so one can be started.
export type Sent =
  | { ok: true; result: Result }
  | { ok: false; message: string; unreachable?: true };

// `token` is the caller's session token. None means you. The daemon answers
// at once, so an answer that takes longer than `answerMs` is given up on.
export function send(
  socket: string,
  call: Call,
  token: string | null = null,
  answerMs = 30_000,
): Promise<Sent> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish({ ok: false, message: `The daemon didn't answer within ${answerMs / 1000} seconds.` });
    }, answerMs);
    const finish = (sent: Sent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      resolve(sent);
    };
    // The handlers go on before connecting: Bun can report a missing socket
    // during the connect call itself.
    const connection = new Socket();
    // Decoded as one stream, so a character split between packets stays whole.
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      text += chunk.toString();
      const end = text.indexOf("\n");
      if (end < 0) {
        if (Buffer.byteLength(text) > MAX_LINE) {
          finish({ ok: false, message: `The answer is longer than ${MAX_LINE} bytes.` });
        }
        return;
      }
      const parsed = parseAnswer(text.slice(0, end));
      if (!parsed.ok) return finish(parsed);
      const answer = parsed.value;
      if (answer.id !== id)
        return finish({ ok: false, message: "The daemon answered another request." });
      finish(
        answer.ok ? { ok: true, result: answer.result } : { ok: false, message: answer.message },
      );
    });
    connection.on("error", (error) => {
      const code = "code" in error ? error.code : null;
      const missing = code === "ENOENT" || code === "ECONNREFUSED";
      const message = `No daemon answers: ${error.message}`;
      finish(missing ? { ok: false, message, unreachable: true } : { ok: false, message });
    });
    connection.on("close", () =>
      finish({ ok: false, message: "The daemon closed the connection without answering." }),
    );
    connection.connect(socket, () => connection.write(encode({ v: VERSION, id, token, call })));
  });
}

// Runs the daemon in the background, and returns a check that says why it
// stopped, or null while it runs.
export type Start = () => Promise<() => string | null>;

// Sends, starting the daemon first if none answers. Two commands can each
// start one: the second daemon stops on the repository's lock, and both
// commands reach the first, so that stop doesn't count as a failure.
export async function sendStarting(
  socket: string,
  call: Call,
  token: string | null,
  start: Start,
  timeoutMs = 10_000,
): Promise<Sent> {
  const first = await send(socket, call, token);
  if (first.ok || first.unreachable !== true) return first;

  const stopped = await start();
  const giveUpAt = Date.now() + timeoutMs;
  for (;;) {
    const sent = await send(socket, call, token);
    if (sent.ok || sent.unreachable !== true) return sent;
    const why = stopped();
    if (why !== null && !why.startsWith(ALREADY_RUNNING)) {
      return { ok: false, message: `The daemon stopped while starting: ${why}` };
    }
    if (Date.now() >= giveUpAt) {
      const seconds = timeoutMs / 1000;
      const message = `The daemon didn't answer within ${seconds} seconds of starting it. See .skelcrew/daemon.log.`;
      return { ok: false, message };
    }
    await Bun.sleep(50);
  }
}
