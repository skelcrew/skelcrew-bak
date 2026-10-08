// How `skel` talks to the daemon: one request on a fresh connection, and the
// answer that carries the same id.

import { connect } from "node:net";
import { type Call, encode, parseAnswer, type Result, VERSION } from "../protocol/protocol";

export type Sent = { ok: true; result: Result } | { ok: false; message: string };

// `token` is the caller's session token. None means you.
export function send(socket: string, call: Call, token: string | null = null): Promise<Sent> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const finish = (sent: Sent) => {
      if (settled) return;
      settled = true;
      connection.destroy();
      resolve(sent);
    };
    const connection = connect(socket, () =>
      connection.write(encode({ v: VERSION, id, token, call })),
    );
    connection.on("data", (chunk) => {
      text += chunk.toString();
      const end = text.indexOf("\n");
      if (end < 0) return;
      const parsed = parseAnswer(text.slice(0, end));
      if (!parsed.ok) return finish(parsed);
      const answer = parsed.value;
      if (answer.id !== id)
        return finish({ ok: false, message: "The daemon answered another request." });
      finish(
        answer.ok ? { ok: true, result: answer.result } : { ok: false, message: answer.message },
      );
    });
    connection.on("error", (error) =>
      finish({ ok: false, message: `No daemon answers: ${error.message}` }),
    );
    connection.on("close", () =>
      finish({ ok: false, message: "The daemon closed the connection without answering." }),
    );
  });
}
