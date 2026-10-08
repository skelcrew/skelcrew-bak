// Reads `skel`'s arguments into a request for the daemon. Nothing here talks
// to the daemon, so every command's reading is tested on its own.

import { parseArgs } from "node:util";
import { TaskId } from "../core/ids";
import type { Intent, Rigor } from "../core/types";
import type { Call, WireInput } from "../protocol/protocol";
import { intent, rigor } from "../store/schema";

export type Read = { ok: true; call: Call } | { ok: false; message: string };

type Flags = Record<string, { type: "boolean" | "string" }>;

export function readArgs(args: string[]): Read {
  const [name = "help", ...rest] = args;
  switch (name) {
    case "ls":
      return within(name, rest, {}, 0, () => ({ ok: true, call: { type: "ls" } }));

    case "add":
      return add(rest);

    case "set":
      return set(rest);

    case "reply":
      return withText(name, rest, "what to reply", (text) => ({ type: "reply", text }));

    case "deny":
      return withText(name, rest, "why", (note) => ({ type: "deny", note }));

    case "approve":
      return bare(name, rest, { type: "approve" });
    case "pause":
      return bare(name, rest, { type: "pause" });
    case "resume":
      return bare(name, rest, { type: "resume" });
    case "start":
      return bare(name, rest, { type: "start_now" });
    case "retry":
      return bare(name, rest, { type: "retry" });
    case "kill":
      return bare(name, rest, { type: "kill" });

    default:
      return {
        ok: false,
        message: `There is no \`skel ${name}\`. Run \`skel help\` for the commands.`,
      };
  }
}

const intentNames: Intent[] = ["ship", "try", "answer"];
const rigorNames: Rigor[] = ["light", "full"];

// `skel add "title"`, which goes through triage unless an intent and a rigor
// say what it is.
function add(args: string[]): Read {
  const flags: Flags = {
    ship: { type: "boolean" },
    try: { type: "boolean" },
    answer: { type: "boolean" },
    light: { type: "boolean" },
    full: { type: "boolean" },
    approve: { type: "boolean" },
    description: { type: "string" },
  };
  return within("add", args, flags, 1, (values, [title]) => {
    if (title === undefined || title.trim() === "") {
      return { ok: false, message: 'Say what the task is, as in `skel add "Fix the button"`.' };
    }
    const intents = intentNames.filter((name) => values[name] === true);
    const rigors = rigorNames.filter((name) => values[name] === true);
    if (intents.length > 1 || rigors.length > 1) {
      return { ok: false, message: "Give one intent and one rigor at most." };
    }
    const [chosenIntent] = intents;
    const [chosenRigor] = rigors;
    const halfAPlan = (chosenIntent === undefined) !== (chosenRigor === undefined);
    if (halfAPlan || (values.approve === true && chosenIntent === undefined)) {
      return {
        ok: false,
        message:
          "To skip triage, give both an intent (--ship, --try or --answer) and a rigor (--light or --full).",
      };
    }
    const plan =
      chosenIntent === undefined || chosenRigor === undefined
        ? null
        : { intent: chosenIntent, rigor: chosenRigor, approve: values.approve === true };
    const description = typeof values.description === "string" ? values.description : null;
    return {
      ok: true,
      call: { type: "send", task: null, input: { type: "add", title, description, plan } },
    };
  });
}

// `skel set 142 --rigor full`: changes only what it names.
function set(args: string[]): Read {
  const flags: Flags = {
    intent: { type: "string" },
    rigor: { type: "string" },
    approve: { type: "boolean" },
    "no-approve": { type: "boolean" },
  };
  return within("set", args, flags, 1, (values, [given]) => {
    const task = taskOf("set", given);
    if (!task.ok) return task;
    const chosenIntent = values.intent === undefined ? null : intent.safeParse(values.intent);
    if (chosenIntent !== null && !chosenIntent.success) {
      return { ok: false, message: "--intent is ship, try or answer." };
    }
    const chosenRigor = values.rigor === undefined ? null : rigor.safeParse(values.rigor);
    if (chosenRigor !== null && !chosenRigor.success) {
      return { ok: false, message: "--rigor is light or full." };
    }
    const approve = values.approve === true ? true : values["no-approve"] === true ? false : null;
    const input: WireInput = {
      type: "set",
      intent: chosenIntent?.data ?? null,
      rigor: chosenRigor?.data ?? null,
      approve,
    };
    return { ok: true, call: { type: "send", task: task.task, input } };
  });
}

// A command that names a task and nothing else.
function bare(name: string, args: string[], input: WireInput): Read {
  return within(name, args, {}, 1, (_values, [given]) => {
    const task = taskOf(name, given);
    if (!task.ok) return task;
    return { ok: true, call: { type: "send", task: task.task, input } };
  });
}

// A command that names a task and says something, as in `skel reply 142 "text"`.
function withText(
  name: string,
  args: string[],
  what: string,
  input: (text: string) => WireInput,
): Read {
  return within(name, args, {}, 2, (_values, [given, text]) => {
    const task = taskOf(name, given);
    if (!task.ok) return task;
    if (text === undefined || text.trim() === "") {
      return { ok: false, message: `Say ${what}, as in \`skel ${name} 142 "text"\`.` };
    }
    return { ok: true, call: { type: "send", task: task.task, input: input(text) } };
  });
}

// Reads the flags and up to `most` plain arguments, refusing anything else.
function within(
  name: string,
  args: string[],
  flags: Flags,
  most: number,
  then: (values: Record<string, string | boolean | undefined>, positionals: string[]) => Read,
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
  const values: Record<string, string | boolean | undefined> = {};
  for (const [key, value] of Object.entries(parsed.values)) {
    values[key] = Array.isArray(value) ? value.join(" ") : value;
  }
  return then(values, parsed.positionals);
}

function taskOf(
  name: string,
  given: string | undefined,
): { ok: true; task: TaskId } | { ok: false; message: string } {
  if (given === undefined) {
    return { ok: false, message: `Say which task, as in \`skel ${name} 142\`.` };
  }
  const task = TaskId.safeParse(Number(given.replace(/^#/, "")));
  if (!task.success || !/^#?\d+$/.test(given)) {
    return { ok: false, message: `${given} isn't a task number.` };
  }
  return { ok: true, task: task.data };
}
