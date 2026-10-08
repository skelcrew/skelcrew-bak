// What every `skel` command shares when it reads its arguments.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Call } from "../protocol/protocol";

export type Read = { ok: true; call: Call } | { ok: false; message: string };

export type Flags = Record<string, { type: "boolean" | "string"; multiple?: boolean }>;
export type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

// Reads a file an agent hands over, such as its brief. Passed in, so the
// tests need no disk.
export type ReadFile = (path: string) => { ok: true; text: string } | { ok: false };

export const fromDisk: ReadFile = (path) => {
  try {
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch {
    return { ok: false };
  }
};

// Reads the flags and up to `most` plain arguments, refusing anything else.
export function within(
  name: string,
  args: string[],
  flags: Flags,
  most: number,
  then: (values: Values, positionals: string[]) => Read,
): Read {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, options: flags, allowPositionals: true, strict: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `\`skel ${name}\`: ${reason}` };
  }
  if (parsed.positionals.length > most) {
    return {
      ok: false,
      message: `\`skel ${name}\` takes ${most === 1 ? "one argument" : `${most} arguments`}.`,
    };
  }
  return then(parsed.values, parsed.positionals);
}

// A flag's text, or null when it wasn't given.
export function text(values: Values, flag: string): string | null {
  const value = values[flag];
  return typeof value === "string" ? value : null;
}
