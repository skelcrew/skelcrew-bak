import { expect, test } from "bun:test";
import { daemonEnv } from "./env";

test("a daemon started from an agent's shell gets no session's variables", () => {
  expect(
    daemonEnv({
      PATH: "/usr/bin",
      HOME: "/home/you",
      SKELCREW_SESSION: "s-1-2.abc",
      SKELCREW_TASK: "1",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      EMPTY: undefined,
    }),
  ).toEqual({ PATH: "/usr/bin", HOME: "/home/you" });
});
