import { describe, expect, test } from "bun:test";
import { readConfig } from "./config";

const full = `
roles:
  planner:
    harness: claude
    model: fast
    instructions: |
      Decide intent and rigor.
  builder:
    harness: claude
    instructions: Do the work.
  tester:
    harness: claude
    instructions: Review the change.

repo:
  setup:    [bun install --frozen-lockfile]
  test:     [bun test, bun run typecheck]
  critical: [src/auth/**, migrations/**]

limits:
  max_running: 4
`;

describe("reading skelcrew.yaml", () => {
  test("gives the core its rules, and keeps the roles and repo commands", () => {
    const read = readConfig(full);

    expect(read.ok && read.settings.config).toEqual({
      maxRunning: 4,
      loopCap: 3,
      critical: ["src/auth/**", "migrations/**"],
    });
    expect(read.ok && read.settings.roles.planner).toEqual({
      harness: "claude",
      model: "fast",
      instructions: "Decide intent and rigor.\n",
    });
    expect(read.ok && read.settings.repo.test).toEqual(["bun test", "bun run typecheck"]);
  });

  test("fills in what a short file leaves out", () => {
    const read = readConfig("limits:\n  max_running: 2\n");

    expect(read.ok && read.settings.config).toEqual({ maxRunning: 2, loopCap: 3, critical: [] });
    expect(read.ok && read.settings.roles.builder).toEqual({
      harness: "claude",
      model: null,
      instructions: "",
    });
    expect(read.ok && read.settings.repo).toEqual({ setup: [], test: [], critical: [] });
  });

  test("treats a missing or empty file as all defaults", () => {
    const read = readConfig("");

    expect(read.ok && read.settings.config.maxRunning).toBe(4);
  });

  test("refuses a bad value, saying where it is", () => {
    expect(readConfig("limits:\n  max_running: lots\n")).toEqual({
      ok: false,
      reasons: ["limits.max_running: expected a number, got string"],
    });
  });

  test("refuses a key it doesn't know, so a typo isn't silently ignored", () => {
    const read = readConfig("limits:\n  max_runing: 2\n");

    expect(read.ok).toBe(false);
    expect(!read.ok && read.reasons.join()).toContain("max_runing");
  });

  test("refuses a file that isn't YAML", () => {
    const read = readConfig("roles: [unclosed\n");

    expect(read.ok).toBe(false);
    expect(!read.ok && read.reasons[0]).toStartWith("Not YAML:");
  });
});
