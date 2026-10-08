// Session tokens: how the daemon knows which session a call comes from. Each
// session gets its token in SKELCREW_SESSION. A call without one is yours.
//
// A token is the session's name, signed with a secret the daemon keeps in
// .skelcrew/. So a token can't be made up from a session's name, a token from
// another repository doesn't work here, and nothing needs storing per
// session: a token still works after the daemon restarts, as its session
// does.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SessionId } from "../core/ids";

// The daemon's secret, made the first time, readable by this user alone.
export function loadSecret(path: string): Buffer {
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600 });
  return readFileSync(path);
}

export class Tokens {
  constructor(private readonly secret: Buffer) {}

  tokenFor(session: SessionId): string {
    return `${session}.${this.sign(session)}`;
  }

  // The session a token names, or null if Skelcrew didn't give it.
  sessionOf(token: string): SessionId | null {
    const dot = token.lastIndexOf(".");
    if (dot < 0) return null;
    const name = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), "hex");
    const expected = Buffer.from(this.sign(name), "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const session = SessionId.safeParse(name);
    return session.success ? session.data : null;
  }

  private sign(name: string): string {
    return createHmac("sha256", this.secret).update(name).digest("hex");
  }
}
