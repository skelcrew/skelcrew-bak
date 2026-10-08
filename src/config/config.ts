// Reads skelcrew.yaml: the repository's settings. Every field is checked
// before anything uses it, and a file that doesn't fit is refused with every
// reason at once, each saying where it is.
//
// A missing file, or one that leaves something out, gets the defaults. An
// unknown key is refused, so a typo can't silently do nothing.

import * as z from "zod";
import type { Config } from "../core/types";

// Build and review round trips before a task is held. The spec fixes it at 3
// until dogfooding shows what it should be, so the file can't set it yet.
const loopCap = 3;

const role = z.strictObject({
  harness: z.literal("claude").default("claude"),
  model: z.string().nullable().default(null),
  instructions: z.string().default(""),
});

const file = z.strictObject({
  roles: z
    .strictObject({
      planner: role.prefault({}),
      builder: role.prefault({}),
      tester: role.prefault({}),
    })
    .prefault({}),
  repo: z
    .strictObject({
      setup: z.array(z.string()).default([]),
      test: z.array(z.string()).default([]),
      critical: z.array(z.string()).default([]),
    })
    .prefault({}),
  limits: z.strictObject({ max_running: z.int().positive().default(4) }).prefault({}),
});

type File = z.infer<typeof file>;
export type Role = File["roles"]["planner"];

export type Settings = {
  config: Config; // what the core needs
  roles: File["roles"];
  repo: File["repo"];
};

export type ReadConfig = { ok: true; settings: Settings } | { ok: false; reasons: string[] };

export function readConfig(text: string): ReadConfig {
  let data: unknown;
  try {
    data = Bun.YAML.parse(text) ?? {};
  } catch (error) {
    return { ok: false, reasons: [`Not YAML: ${String(error)}`] };
  }

  const parsed = file.safeParse(data, { reportInput: true });
  if (!parsed.success) return { ok: false, reasons: parsed.error.issues.map(describe) };

  const { roles, repo, limits } = parsed.data;
  const config = { maxRunning: limits.max_running, loopCap, critical: repo.critical };
  return { ok: true, settings: { config, roles, repo } };
}

// One problem, in plain words, after the path to the value it is about.
function describe(issue: z.core.$ZodIssue): string {
  const where = issue.path.length === 0 ? "the file" : issue.path.join(".");
  if (issue.code === "invalid_type") {
    const got = issue.input === null ? "null" : typeof issue.input;
    return `${where}: expected a ${issue.expected}, got ${got}`;
  }
  if (issue.code === "unrecognized_keys") {
    return `${where}: unknown ${issue.keys.length === 1 ? "key" : "keys"} ${issue.keys.join(", ")}`;
  }
  return `${where}: ${issue.message}`;
}
