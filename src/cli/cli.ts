// `skel`: reads its arguments, sends them to the daemon, and prints the
// answer. It holds no state. The session's token, if any, comes from
// SKELCREW_SESSION, so an agent's calls are known as its own.

import type { Sent } from "../daemon/client";
import type { Call, Row, WireInput } from "../protocol/protocol";
import { readArgs } from "./args";

export type Io = {
  env: Record<string, string | undefined>;
  send: (call: Call, token: string | null) => Promise<Sent>;
  out: (line: string) => void;
  err: (line: string) => void;
};

// Returns the exit code: 0 when the daemon accepted, 1 when anything refused.
export async function run(args: string[], io: Io): Promise<number> {
  if (args.length === 0 || args[0] === "help") {
    for (const line of help) io.out(line);
    return 0;
  }
  const read = readArgs(args);
  if (!read.ok) {
    io.err(read.message);
    return 1;
  }
  const token = io.env.SKELCREW_SESSION ?? null;
  const sent = await io.send(read.call, token === "" ? null : token);
  if (!sent.ok) {
    io.err(sent.message);
    return 1;
  }

  const result = sent.result;
  if (result.kind === "tasks") {
    for (const line of table(result.tasks)) io.out(line);
  } else if (read.call.type === "send") {
    io.out(`${done(read.call.input)} #${result.task}.`);
  }
  return 0;
}

const help = [
  "skel serve                            run the daemon for this repository",
  'skel add "Fix the button"             a new task; --ship/--try/--answer with',
  "                                      --light/--full (and --approve) skip triage",
  "skel ls                               tasks, phase, intent and rigor",
  "skel set 142 --rigor full             change --intent, --rigor or --approve/--no-approve",
  'skel reply 142 "No, skip archived"    answer a question',
  'skel approve 142 / skel deny 142 "why"',
  "skel pause 142 / skel resume 142",
  "skel start 142                        start now, even past max_running",
  "skel retry 142                        carry on after a hold",
  "skel kill 142",
];

// What an accepted input did, as the start of a sentence about its task.
function done(input: WireInput): string {
  switch (input.type) {
    case "add":
      return "Added";
    case "set":
      return "Changed";
    case "reply":
      return "Replied to";
    case "approve":
      return "Approved";
    case "deny":
      return "Denied";
    case "decide_proposals":
      return "Decided on the proposals of";
    case "pause":
      return "Paused";
    case "resume":
      return "Resumed";
    case "start_now":
      return "Started";
    case "retry":
      return "Retrying";
    case "kill":
      return "Killed";
    default:
      return "Sent to";
  }
}

// `skel ls`: one task per line, in columns.
function table(rows: Row[]): string[] {
  if (rows.length === 0) return ["No tasks."];
  const cells = rows.map((row) => [
    `#${row.task}`,
    row.phase,
    row.intent === null || row.rigor === null ? "-" : `${row.intent}, ${row.rigor}`,
    row.state,
    row.title,
  ]);
  const widths = [0, 1, 2, 3].map((column) =>
    Math.max(...cells.map((cell) => (cell[column] ?? "").length)),
  );
  return cells.map((cell) =>
    cell
      .map((text, column) => text.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}
