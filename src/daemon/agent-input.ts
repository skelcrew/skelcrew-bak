// An agent's request as the core's input. The daemon adds what the agent
// doesn't get to say: the branch, as git sees it, and the text of each file
// the agent hands over, read when the command arrives, as the spec says.

import { readFileSync } from "node:fs";
import type { AgentInput, BranchFacts } from "../core/types";
import type { WireInput } from "../protocol/protocol";

// An agent's input before the daemon adds its session, known from the token.
export type Unsigned = DistributiveOmit<AgentInput, "session">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type Made = { ok: true; input: Unsigned } | { ok: false; message: string };

// The input, or why it can't be made, or null when the request is one of
// yours rather than an agent's.
export function agentInput(input: WireInput, branch: () => BranchFacts): Made | null {
  try {
    switch (input.type) {
      case "triage_proceed":
        return made({
          type: "triage_proceed",
          plan: { ...input.plan, brief: text(input.briefFile) },
          spec: input.specFile === null ? null : text(input.specFile),
        });
      case "triage_split":
        return made({ type: "triage_split", proposals: proposals(text(input.tasksFile)) });
      case "done":
        return made({ type: "done", summary: text(input.summaryFile), branch: branch() });
      case "done_answer":
        return made({
          type: "done_answer",
          report: text(input.reportFile),
          proposals: input.tasksFile === null ? [] : proposals(text(input.tasksFile)),
          branch: branch(),
        });
      case "pass":
        return made({ type: "pass", evidence: text(input.evidenceFile) });
      case "changes":
        return made({ type: "changes", findings: text(input.findingsFile) });
      case "triage_decline":
      case "ask":
      case "progress":
      case "give_up":
        return made(input);
      default:
        return null;
    }
  } catch (error) {
    if (error instanceof Unreadable) return { ok: false, message: `${error.path} can't be read.` };
    throw error;
  }
}

function made(input: Unsigned): Made {
  return { ok: true, input };
}

class Unreadable extends Error {
  constructor(readonly path: string) {
    super(`${path} can't be read.`);
  }
}

function text(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Unreadable(path);
  }
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
