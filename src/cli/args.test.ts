import { describe, expect, test } from "bun:test";
import { TaskId } from "../core/ids";
import type { WireInput } from "../protocol/protocol";
import { type Read, readArgs } from "./args";

const task = TaskId.parse(142);

describe("your commands", () => {
  test("add, going through triage", () => {
    expect(readArgs(["add", "Fix the button colour"])).toEqual({
      ok: true,
      call: {
        type: "send",
        task: null,
        input: { type: "add", title: "Fix the button colour", description: null, plan: null },
      },
    });
  });

  test("add, skipping triage with an intent and a rigor", () => {
    expect(
      readArgs(["add", "Fix it", "--try", "--full", "--approve", "--description", "Why"]),
    ).toEqual({
      ok: true,
      call: {
        type: "send",
        task: null,
        input: {
          type: "add",
          title: "Fix it",
          description: "Why",
          plan: { intent: "try", rigor: "full", approve: true },
        },
      },
    });
  });

  test("add with only half a plan is refused, saying what is missing", () => {
    expect(readArgs(["add", "Fix it", "--ship"])).toEqual({
      ok: false,
      message:
        "To skip triage, give both an intent (--ship, --try or --answer) and a rigor (--light or --full).",
    });
  });

  test("ls", () => {
    expect(readArgs(["ls"])).toEqual({ ok: true, call: { type: "ls" } });
  });

  test("set changes only what it names", () => {
    expect(readArgs(["set", "142", "--rigor", "full"])).toEqual({
      ok: true,
      call: {
        type: "send",
        task,
        input: { type: "set", intent: null, rigor: "full", approve: null },
      },
    });
    expect(readArgs(["set", "142", "--no-approve"])).toEqual({
      ok: true,
      call: {
        type: "send",
        task,
        input: { type: "set", intent: null, rigor: null, approve: false },
      },
    });
  });

  test("reply, approve and deny", () => {
    expect(readArgs(["reply", "142", "No, skip archived items"])).toEqual({
      ok: true,
      call: { type: "send", task, input: { type: "reply", text: "No, skip archived items" } },
    });
    expect(readArgs(["approve", "142"])).toEqual({
      ok: true,
      call: { type: "send", task, input: { type: "approve" } },
    });
    expect(readArgs(["deny", "142", "Too risky"])).toEqual({
      ok: true,
      call: { type: "send", task, input: { type: "deny", note: "Too risky" } },
    });
  });

  test("pause, resume, start, retry and kill", () => {
    const inputs: [string, WireInput][] = [
      ["pause", { type: "pause" }],
      ["resume", { type: "resume" }],
      ["start", { type: "start_now" }],
      ["retry", { type: "retry" }],
      ["kill", { type: "kill" }],
    ];
    for (const [command, input] of inputs) {
      expect(readArgs([command, "142"])).toEqual({ ok: true, call: { type: "send", task, input } });
    }
  });

  test("a task can be given as #142", () => {
    expect(readArgs(["kill", "#142"])).toEqual({
      ok: true,
      call: { type: "send", task, input: { type: "kill" } },
    });
  });
});

describe("a command that can't be read", () => {
  test("is refused when unknown", () => {
    expect(readArgs(["launch", "142"])).toEqual({
      ok: false,
      message: "There is no `skel launch`. Run `skel help` for the commands.",
    });
  });

  test("is refused without its task", () => {
    expect(readArgs(["kill"])).toEqual({
      ok: false,
      message: "Say which task, as in `skel kill 142`.",
    });
  });

  test("is refused with a task that isn't a number", () => {
    expect(readArgs(["kill", "soon"])).toEqual({
      ok: false,
      message: "soon isn't a task number.",
    });
  });

  test("is refused with an option it doesn't take", () => {
    const read = readArgs(["kill", "142", "--force"]);

    expect(read.ok).toBe(false);
    expect(!read.ok && read.message).toContain("--force");
  });

  test("is refused when its text is missing", () => {
    expect(readArgs(["reply", "142"])).toEqual({
      ok: false,
      message: 'Say what to reply, as in `skel reply 142 "text"`.',
    });
  });
});

describe("an agent's commands", () => {
  // Files an agent hands over, by path.
  const files: Record<string, string> = {
    "brief.md": "Skip empty header rows.",
    "spec.md": "# Spec",
    "summary.md": "Fixed the export.",
    "report.md": "It's the cache.",
    "evidence.md": "Tests pass.",
    "findings.md": "The empty case still fails.",
    "tasks.md": "## Fix the cache\nClear it on write.\n\n## Add a test\nFor the empty export.\n",
  };
  const read = (args: string[]) =>
    readArgs(args, (path) =>
      path in files ? { ok: true, text: files[path] ?? "" } : { ok: false },
    );
  const sends = (input: WireInput): Read => ({
    ok: true,
    call: { type: "send", task: null, input },
  });

  test("triage proceed, with the brief and spec read from their files", () => {
    expect(
      read([
        "triage",
        "proceed",
        "--intent",
        "ship",
        "--rigor",
        "full",
        "--approve",
        "--brief",
        "brief.md",
        "--spec",
        "spec.md",
      ]),
    ).toEqual(
      sends({
        type: "triage_proceed",
        plan: { intent: "ship", rigor: "full", approve: true, brief: "Skip empty header rows." },
        spec: "# Spec",
      }),
    );
  });

  test("triage proceed needs an intent, a rigor and a brief", () => {
    expect(read(["triage", "proceed", "--intent", "ship", "--brief", "brief.md"])).toEqual({
      ok: false,
      message: "`skel triage proceed` needs --intent, --rigor and --brief.",
    });
  });

  test("triage split, with one task per heading", () => {
    expect(read(["triage", "split", "tasks.md"])).toEqual(
      sends({
        type: "triage_split",
        proposals: [
          { title: "Fix the cache", description: "Clear it on write." },
          { title: "Add a test", description: "For the empty export." },
        ],
      }),
    );
  });

  test("triage ask and triage decline", () => {
    expect(
      read(["triage", "ask", "Include archived items?", "--option", "yes", "--option", "no"]),
    ).toEqual(sends({ type: "ask", text: "Include archived items?", options: ["yes", "no"] }));
    expect(read(["triage", "decline", "Already fixed in #131"])).toEqual(
      sends({ type: "triage_decline", reason: "Already fixed in #131" }),
    );
  });

  test("ask, progress and give-up", () => {
    expect(read(["ask", "Keep the old format too?"])).toEqual(
      sends({ type: "ask", text: "Keep the old format too?", options: [] }),
    );
    expect(read(["progress", "Found the cause"])).toEqual(
      sends({ type: "progress", text: "Found the cause" }),
    );
    expect(read(["give-up", "Needs credentials I don't have"])).toEqual(
      sends({ type: "give_up", message: "Needs credentials I don't have" }),
    );
  });

  test("done, with a summary or with a report and proposed tasks", () => {
    expect(read(["done", "--summary", "summary.md"])).toEqual(
      sends({ type: "done", summary: "Fixed the export." }),
    );
    expect(read(["done", "--report", "report.md", "--tasks", "tasks.md"])).toEqual(
      sends({
        type: "done_answer",
        report: "It's the cache.",
        proposals: [
          { title: "Fix the cache", description: "Clear it on write." },
          { title: "Add a test", description: "For the empty export." },
        ],
      }),
    );
  });

  test("done needs a summary or a report, not both", () => {
    expect(read(["done"])).toEqual({
      ok: false,
      message: "`skel done` needs --summary, or --report for an answer.",
    });
  });

  test("pass and changes", () => {
    expect(read(["pass", "--evidence", "evidence.md"])).toEqual(
      sends({ type: "pass", evidence: "Tests pass." }),
    );
    expect(read(["changes", "findings.md"])).toEqual(
      sends({ type: "changes", findings: "The empty case still fails." }),
    );
  });

  test("a file that can't be read is refused, naming it", () => {
    expect(read(["pass", "--evidence", "missing.md"])).toEqual({
      ok: false,
      message: "missing.md can't be read.",
    });
  });
});
