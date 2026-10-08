# Learnings from v3

v3 lives in `~/skelcrew-v3`. It is inspiration only: v4 starts over and copies nothing by
default. This file records what v3 got right, and the traps it found the hard way, so v4
doesn't pay for them twice.

Paths below are in the v3 repository.

## Code worth reusing

Each of these was hardened by real bugs. Read it before writing v4's version, and copy it
when it fits.

- **The tmux runner** (`src/plugins/tmux-runner/tmux-runner.ts`). Its own tmux server per
  repository, panes kept after exit, sessions found again after a restart, step-in with
  `ctrl-]` to step out.
- **The session runner contract tests** (`src/plugins/session-runner.contract.ts`). Every
  runner must pass them. They use a short shell script in place of a real agent.
- **The Claude Code profile** (`src/plugins/claude-code/claude-code.ts`). Launch flags,
  permissions per role, the folder trust check, bracketed paste for messages, and reading
  usage and activity from the transcript.
- **The lock, socket paths and client** (`src/daemon/lock.ts`, `src/daemon/paths.ts`,
  `src/daemon/client.ts`). One daemon per repository through `flock`, a socket path that
  fits macOS's limit, and a client that starts the daemon when none runs.
- **The fresh copy for checks** (`src/plugins/git/git.ts`, the `.skelcrew/checking/` copy).
  A detached worktree at the exact commit, marked as Skelcrew's own, removed afterwards.
- **`lastLine`** (`src/plugins/last-line.ts`). An agent's last line of output with every
  terminal code removed, for saying why a session ended.
- **The test watchdog** (`src/checks/run-tests.ts`). Runs the tests in their own process
  group and stops the whole group after 6 minutes.
- **The loop** (`src/loop/loop.ts`). Decide, save, evolve, carry out, with the outbox and
  the count of starts and stops in flight. v4's spec describes the same loop.
- **The simulator** (`src/sim/simulator.ts`). The real loop with fake tools and scripted
  agents, so whole lifecycles run in milliseconds.

## Traps

Each of these cost v3 at least one bug.

- **Claude Code needs a long message marked as a paste.** Without bracketed paste marks,
  the Enter after a long message adds a new line and the message is never sent.
- **tmux reads a trailing `;` as a command separator**, even with `send-keys -l`. Escape it.
- **Target tmux sessions with `=name:`.** A bare name matches by prefix, so `session-1` could
  hit `session-12`.
- **Remove `CLAUDE_CODE_CHILD_SESSION` and related variables** before starting an agent. A
  daemon started from your own Claude Code session passes them on, and an agent with them
  writes no transcript.
- **Folder trust is the developer's.** Claude Code asks once per repository. Skelcrew checks
  `~/.claude.json` and refuses to start an agent in an untrusted folder. It never grants
  trust itself.
- **Commit forms the allow list doesn't expect.** `git -c … commit` gets round a rule for
  `git commit`. Allow only the plain form, and deny `--no-verify` and `-n`.
- **A background agent can wait without asking.** On v3's task #57, an agent wrote "send me
  a message here" into its session and stopped. Skelcrew showed it as working. The fix is
  the protocol preamble's rule that every wait goes through `ask`, and in v4, stall
  detection.
- **Replies get lost.** A reply that can't be saved must be sent again until it is, and a
  repeated command must change nothing. This took several rounds of fixes in v3.
- **Starts in flight must survive a restart.** Otherwise slots are miscounted until every
  start has answered.
- **Bun's test runner can hang** at full CPU, past every timer inside the run. Only a
  separate process can stop it.
- **macOS limits a socket path to 103 bytes.** A deep repository needs its socket elsewhere.

## What v3 never built

These are the riskiest parts of v4, since nothing in v3 tested them:

- the reviewer, and `done` waiting for a verdict from an agent that may run a long time
- stall detection
- resuming a harness session (`claude --resume`)

## Where v3's complexity went

Most of v3's code beyond the core served things v4 drops: merging and merge approval,
treating a merge on GitHub as approval, revert, attended claims from your own harness,
projects, and the basic runner. v4's core can be much smaller. The daemon around it can't
be: slot accounting, recovery and the outbox are real work in any version.
