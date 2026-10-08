// The daemon's socket. It reads one request per line and writes back one
// answer per line. Many connections can be open at once, and each may send
// many requests. Each is answered as a whole before the next is read, so the
// daemon handles one at a time.

import { chmodSync } from "node:fs";
import { createServer } from "node:net";
import { encode, MAX_LINE, VERSION } from "../protocol/protocol";

export type Listening = { stop(): Promise<void> };

// `answer` turns one line into the line to send back.
export function listen(socket: string, answer: (line: string) => string): Promise<Listening> {
  const server = createServer((connection) => {
    // Decoded as one stream, so a character split between packets stays whole.
    connection.setEncoding("utf8");
    let text = "";
    connection.on("data", (chunk) => {
      text += chunk.toString();
      for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n")) {
        const line = text.slice(0, end);
        text = text.slice(end + 1);
        connection.write(answer(line));
      }
      // A line that never ends can't be read without end.
      if (Buffer.byteLength(text) > MAX_LINE) {
        connection.end(refusal(`The request is longer than ${MAX_LINE} bytes.`));
        text = "";
      }
    });
    connection.on("error", () => {
      // The client went away. Nothing to answer.
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      // Only this user may talk to the daemon.
      chmodSync(socket, 0o600);
      resolve({
        stop: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// An answer for a line too broken to read an id from.
export function refusal(message: string): string {
  return encode({ v: VERSION, id: "unknown", ok: false, message });
}
