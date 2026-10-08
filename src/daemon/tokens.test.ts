import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { SessionId } from "../core/ids";
import { cleanUp, folder } from "./testing";
import { loadSecret, Tokens } from "./tokens";

afterEach(cleanUp);

const session = SessionId.parse("s-1-2");

describe("a session token", () => {
  test("names its session", () => {
    const tokens = new Tokens(loadSecret(join(folder(), "secret")));

    expect(tokens.sessionOf(tokens.tokenFor(session))).toBe(session);
  });

  test("can't be made up from a session's name", () => {
    const tokens = new Tokens(loadSecret(join(folder(), "secret")));

    expect(tokens.sessionOf(`${session}.0000`)).toBeNull();
    expect(tokens.sessionOf(session)).toBeNull();
    expect(tokens.sessionOf("")).toBeNull();
  });

  test("from another repository's daemon doesn't work here", () => {
    const here = new Tokens(loadSecret(join(folder(), "secret")));
    const there = new Tokens(loadSecret(join(folder(), "secret")));

    expect(here.sessionOf(there.tokenFor(session))).toBeNull();
  });

  // Sessions outlive the daemon, so their tokens must too.
  test("still works after the daemon restarts", () => {
    const path = join(folder(), "secret");
    const token = new Tokens(loadSecret(path)).tokenFor(session);

    expect(new Tokens(loadSecret(path)).sessionOf(token)).toBe(session);
  });

  test("is signed with a secret only this user can read", () => {
    const path = join(folder(), "secret");
    loadSecret(path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
