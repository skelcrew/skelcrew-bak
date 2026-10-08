// Fake tools: what git, tmux and delivery would answer each command, without
// doing anything. The simulator uses them in tests, and the daemon until the
// real tools arrive in milestone 4.
//
// A command sent again, say after a restart, gets the same answer it got the
// first time, as a real tool must give.

import { CommitSha, SessionId } from "../core/ids";
import type { BranchFacts, Command, Input, TaskId } from "../core/types";

export class FakeTools {
  // Each answer given, by command and request.
  private readonly answers = new Map<string, Input | null>();
  private commits = 0;

  // `conflicts` says whether merging main into a task conflicts this time.
  // Never, unless given.
  constructor(private readonly conflicts: (taskId: TaskId) => boolean = () => false) {}

  // The reply to a command, or null for one with no reply.
  answer(command: Command): Input | null {
    if (!("request" in command)) return this.replyTo(command);
    const key = `${command.type}:${command.taskId}:${command.request}`;
    const given = this.answers.get(key);
    if (given !== undefined) return given;
    const answer = this.replyTo(command);
    this.answers.set(key, answer);
    return answer;
  }

  private replyTo(command: Command): Input | null {
    switch (command.type) {
      case "create_workspace":
        return {
          by: "plugin",
          type: "workspace_created",
          request: command.request,
          workspace: { path: `/sim/${command.taskId}`, branch: `skel/${command.taskId}` },
        };

      case "create_copy":
        return {
          by: "plugin",
          type: "copy_created",
          request: command.request,
          copy: { path: `/sim/${command.taskId}-copy-${command.request}`, commit: command.commit },
        };

      case "start_session":
        return {
          by: "plugin",
          type: "session_started",
          request: command.request,
          session: sessionOf(command),
        };

      // A late session's cleanup stop has no reply.
      case "stop_session":
        if (command.request === null) return null;
        return {
          by: "plugin",
          type: "stopped",
          request: command.request,
          session: command.session,
          saved: command.save ? "saved" : "nothing_to_save",
          message: "",
        };

      case "commit_spec":
        return {
          by: "plugin",
          type: "spec_committed",
          request: command.request,
          path: `docs/plans/${command.taskId}.md`,
        };

      case "merge_main":
        if (this.conflicts(command.taskId)) {
          return {
            by: "plugin",
            type: "main_conflict",
            request: command.request,
            files: ["src/x.ts"],
          };
        }
        return {
          by: "plugin",
          type: "main_merged",
          request: command.request,
          reviewed: { head: this.commit(), changedFiles: ["src/x.ts"] },
        };

      case "deliver": {
        const commit = command.reviewed.head;
        return {
          by: "plugin",
          type: "delivered",
          request: command.request,
          delivered:
            command.intent === "answer"
              ? { kind: "report", path: `docs/answers/${command.taskId}.md`, commit }
              : { kind: "branch", commit, ref: `skel/${command.taskId}` },
        };
      }

      case "remove_workspace":
      case "type_into_session":
        return null;
    }
  }

  // What git would say about a task's branch when its agent is done: a new
  // commit, with one file changed.
  branch(): BranchFacts {
    return { head: this.commit(), changedFiles: ["src/x.ts"] };
  }

  // A new commit, never the same as one before. Shared with the simulator's
  // builders, so no two commits are confused.
  commit(): CommitSha {
    this.commits++;
    return CommitSha.parse(this.commits.toString(16).padStart(40, "0"));
  }
}

// The session a start makes: the same for a start sent again.
export function sessionOf(command: Extract<Command, { type: "start_session" }>): SessionId {
  return SessionId.parse(`s-${command.taskId}-${command.request}`);
}
