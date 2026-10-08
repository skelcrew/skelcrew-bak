// Reads an agent's `skel` commands into a request. The task isn't named: the
// daemon knows it from the session's token. A file an agent hands over, such
// as its brief, goes by its full path, and the daemon reads it when the
// command arrives, as the spec says.

import { resolve } from "node:path";
import type { WireInput } from "../protocol/protocol";
import { intent, rigor } from "../store/schema";
import { type Flags, type Read, text, type Values, within } from "./parse";

// The request for one agent command, or null when `name` isn't one. Paths are
// taken from `cwd`, the folder skel runs in.
export function readAgentArgs(name: string, args: string[], cwd: string): Read | null {
  const full = (path: string) => resolve(cwd, path);
  switch (name) {
    case "triage": {
      const [action = "", ...rest] = args;
      switch (action) {
        case "proceed":
          return proceed(rest, full);
        case "split":
          return named("triage split", rest, (path) => ({
            type: "triage_split",
            tasksFile: full(path),
          }));
        case "ask":
          return ask("triage ask", rest);
        case "decline":
          return said("triage decline", rest, "why", (reason) => ({
            type: "triage_decline",
            reason,
          }));
        default:
          return { ok: false, message: "`skel triage` is proceed, split, ask or decline." };
      }
    }
    case "ask":
      return ask(name, args);
    case "progress":
      return said(name, args, "what you found", (text) => ({ type: "progress", text }));
    case "give-up":
      return said(name, args, "why", (message) => ({ type: "give_up", message }));
    case "done":
      return done(args, full);
    case "pass":
      return within(name, args, { evidence: { type: "string" } }, 0, (values) => {
        const evidence = text(values, "evidence");
        if (evidence === null) return { ok: false, message: "`skel pass` needs --evidence." };
        return sends({ type: "pass", evidenceFile: full(evidence) });
      });
    case "changes":
      return named(name, args, (path) => ({ type: "changes", findingsFile: full(path) }));
    default:
      return null;
  }
}

// `skel triage proceed --intent ship --rigor full [--approve] --brief brief.md [--spec spec.md]`
function proceed(args: string[], full: (path: string) => string): Read {
  const flags: Flags = {
    intent: { type: "string" },
    rigor: { type: "string" },
    approve: { type: "boolean" },
    brief: { type: "string" },
    spec: { type: "string" },
  };
  return within("triage proceed", args, flags, 0, (values) => {
    const chosenIntent = intent.safeParse(values.intent);
    const chosenRigor = rigor.safeParse(values.rigor);
    const brief = text(values, "brief");
    if (!chosenIntent.success || !chosenRigor.success || brief === null) {
      return { ok: false, message: "`skel triage proceed` needs --intent, --rigor and --brief." };
    }
    const spec = text(values, "spec");
    return sends({
      type: "triage_proceed",
      plan: {
        intent: chosenIntent.data,
        rigor: chosenRigor.data,
        approve: values.approve === true,
      },
      briefFile: full(brief),
      specFile: spec === null ? null : full(spec),
    });
  });
}

// `skel done --summary summary.md`, or for an answer
// `skel done --report report.md [--tasks tasks.md]`.
function done(args: string[], full: (path: string) => string): Read {
  const flags: Flags = {
    summary: { type: "string" },
    report: { type: "string" },
    tasks: { type: "string" },
  };
  return within("done", args, flags, 0, (values) => {
    const summary = text(values, "summary");
    const report = text(values, "report");
    if (summary !== null && report === null) {
      return sends({ type: "done", summaryFile: full(summary) });
    }
    if (report !== null && summary === null) {
      const tasks = text(values, "tasks");
      return sends({
        type: "done_answer",
        reportFile: full(report),
        tasksFile: tasks === null ? null : full(tasks),
      });
    }
    return { ok: false, message: "`skel done` needs --summary, or --report for an answer." };
  });
}

// `skel ask "question" [--option yes --option no]`
function ask(name: string, args: string[]): Read {
  const flags: Flags = { option: { type: "string", multiple: true } };
  return within(name, args, flags, 1, (values, [question]) => {
    if (question === undefined || question.trim() === "") {
      return {
        ok: false,
        message: `Say what to ask, as in \`skel ${name} "Keep the old format?"\`.`,
      };
    }
    return sends({ type: "ask", text: question, options: options(values) });
  });
}

// A command that says one thing, as in `skel progress "text"`.
function said(
  name: string,
  args: string[],
  what: string,
  input: (said: string) => WireInput,
): Read {
  return within(name, args, {}, 1, (_values, [given]) => {
    if (given === undefined || given.trim() === "") {
      return { ok: false, message: `Say ${what}, as in \`skel ${name} "text"\`.` };
    }
    return sends(input(given));
  });
}

// A command that names one file, as in `skel changes findings.md`.
function named(name: string, args: string[], input: (path: string) => WireInput): Read {
  return within(name, args, {}, 1, (_values, [path]) => {
    if (path === undefined) {
      return { ok: false, message: `Name the file, as in \`skel ${name} file.md\`.` };
    }
    return sends(input(path));
  });
}

function options(values: Values): string[] {
  const given = values.option;
  return Array.isArray(given) ? given.filter((option) => typeof option === "string") : [];
}

function sends(input: WireInput): Read {
  return { ok: true, call: { type: "send", task: null, input } };
}
