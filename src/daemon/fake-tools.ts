// The daemon's fake tools, until milestone 4 brings git, tmux and Claude Code
// and this file goes. They answer as the simulator's fakes do.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BranchFacts, Task } from "../core/types";
import type { Tools } from "../loop/loop";
import { FakeTools } from "../sim/fakes";
import type { Tokens } from "./tokens";

// The tools, and what git would say about a task's branch. Each reply comes
// back a moment later, never from inside carryOut.
//
// A fake session has no environment to hold its token, so the fake runner
// writes the task's latest token to `sessions`/<task>. You stand in for its
// agent with SKELCREW_SESSION=$(cat .skelcrew/sessions/1).
export function fakeTools(
  tokens: Tokens,
  sessions: string,
): { tools: Tools; branchOf: (task: Task) => BranchFacts } {
  const fakes = new FakeTools();
  const tools: Tools = {
    carryOut: (command, reply) => {
      const answer = fakes.answer(command);
      if (answer?.type === "session_started" && command.type === "start_session") {
        mkdirSync(sessions, { recursive: true });
        writeFileSync(join(sessions, `${command.taskId}`), `${tokens.tokenFor(answer.session)}\n`);
      }
      setTimeout(() => {
        try {
          reply(answer);
        } catch (error) {
          // A reply that doesn't fit its command. Its command stays in the
          // outbox, and goes out again at the next start.
          console.error(
            `A tool's reply failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }, 0);
    },
  };
  return { tools, branchOf: (task) => fakes.branch(`${task.id}:${task.requests}`) };
}
