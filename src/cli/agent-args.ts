// Reads an agent's `skel` commands into a request. The task isn't named: the
// daemon knows it from the session's token. Files an agent hands over, such
// as its brief, are read here and sent as text, so the daemon never reads an
// agent's files.

import type { WireInput } from "../protocol/protocol";
import { intent, rigor } from "../store/schema";
import { type Flags, type Read, type ReadFile, text, type Values, within } from "./parse";

// The request for one agent command, or null when `name` isn't one.
export function readAgentArgs(name: string, args: string[], files: ReadFile): Read | null {
  switch (name) {
    case "triage": {
      const [action = "", ...rest] = args;
      switch (action) {
        case "proceed":
          return proceed(rest, files);
        case "split":
          return fromFile("triage split", rest, files, (body) => ({
            type: "triage_split",
            proposals: proposals(body),
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
      return done(args, files);
    case "pass":
      return within(name, args, { evidence: { type: "string" } }, 0, (values) =>
        withFile(text(values, "evidence"), files, "`skel pass` needs --evidence.", (evidence) => ({
          type: "pass",
          evidence,
        })),
      );
    case "changes":
      return fromFile(name, args, files, (findings) => ({ type: "changes", findings }));
    default:
      return null;
  }
}

// `skel triage proceed --intent ship --rigor full [--approve] --brief brief.md [--spec spec.md]`
function proceed(args: string[], files: ReadFile): Read {
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
    const briefPath = text(values, "brief");
    if (!chosenIntent.success || !chosenRigor.success || briefPath === null) {
      return { ok: false, message: "`skel triage proceed` needs --intent, --rigor and --brief." };
    }
    const brief = files(briefPath);
    if (!brief.ok) return cannotRead(briefPath);
    const specPath = text(values, "spec");
    const spec = specPath === null ? null : files(specPath);
    if (spec !== null && !spec.ok) return cannotRead(specPath ?? "");
    const plan = {
      intent: chosenIntent.data,
      rigor: chosenRigor.data,
      approve: values.approve === true,
      brief: brief.text,
    };
    return sends({ type: "triage_proceed", plan, spec: spec?.text ?? null });
  });
}

// `skel done --summary summary.md`, or for an answer
// `skel done --report report.md [--tasks tasks.md]`.
function done(args: string[], files: ReadFile): Read {
  const flags: Flags = {
    summary: { type: "string" },
    report: { type: "string" },
    tasks: { type: "string" },
  };
  return within("done", args, flags, 0, (values) => {
    const summary = text(values, "summary");
    const report = text(values, "report");
    if ((summary === null) === (report === null)) {
      return { ok: false, message: "`skel done` needs --summary, or --report for an answer." };
    }
    if (summary !== null)
      return withFile(summary, files, "", (body) => ({ type: "done", summary: body }));
    const tasksPath = text(values, "tasks");
    const tasks = tasksPath === null ? null : files(tasksPath);
    if (tasks !== null && !tasks.ok) return cannotRead(tasksPath ?? "");
    return withFile(report, files, "", (body) => ({
      type: "done_answer",
      report: body,
      proposals: tasks === null ? [] : proposals(tasks.text),
    }));
  });
}

// `skel ask "question" [--option yes --option no]`
function ask(name: string, args: string[]): Read {
  return within(
    name,
    args,
    { option: { type: "string", multiple: true } },
    1,
    (values, [question]) => {
      if (question === undefined || question.trim() === "") {
        return {
          ok: false,
          message: `Say what to ask, as in \`skel ${name} "Keep the old format?"\`.`,
        };
      }
      return sends({ type: "ask", text: question, options: options(values) });
    },
  );
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

// A command that hands over one file, as in `skel changes findings.md`.
function fromFile(
  name: string,
  args: string[],
  files: ReadFile,
  input: (body: string) => WireInput,
): Read {
  return within(name, args, {}, 1, (_values, [path]) =>
    withFile(path ?? null, files, `Name the file, as in \`skel ${name} file.md\`.`, input),
  );
}

function withFile(
  path: string | null,
  files: ReadFile,
  missing: string,
  input: (body: string) => WireInput,
): Read {
  if (path === null) return { ok: false, message: missing };
  const read = files(path);
  return read.ok ? sends(input(read.text)) : cannotRead(path);
}

// Proposed tasks, one per `## Title` heading, with the text below it as the
// task's description.
function proposals(markdown: string): { title: string; description: string }[] {
  return markdown
    .split(/^## /m)
    .slice(1)
    .map((section) => {
      const [title = "", ...rest] = section.split("\n");
      return { title: title.trim(), description: rest.join("\n").trim() };
    });
}

function options(values: Values): string[] {
  const given = values.option;
  return Array.isArray(given) ? given.filter((option) => typeof option === "string") : [];
}

function sends(input: WireInput): Read {
  return { ok: true, call: { type: "send", task: null, input } };
}

function cannotRead(path: string): Read {
  return { ok: false, message: `${path} can't be read.` };
}
