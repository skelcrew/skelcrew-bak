# Learnings from v3

v3 lives in `~/skelcrew-v3`. It is inspiration only: v4 starts over and copies nothing by
default. This file records what v3 got right, and the traps it found the hard way, so v4
doesn't pay for them twice.

Paths below are in the v3 repository.

## Product lessons

- **Not every task needs every phase.** v3 ran every task through spec, build, checks and
  review. That was its main complaint. v4 answers it with intent and rigor.
- **Rigidity gets routed around.** In v3 you couldn't pause or start tasks, had to wait for
  slots, and couldn't move work around. Small fixes ended up done outside Skelcrew, where it
  guards nothing. v4 lets you start past `max_running`, pause, resume and overrule triage.
- **Keep it as simple as possible.** Every edge case found in review tends to become a rule,
  a state or a refusal. Cut or simplify first. Show you something rather than automate it.
  Wait or let you override rather than refuse.

## What the v4 spike found

A spike before the core, run against Claude Code 2.1.294 in tmux:

- **`claude --resume` drops the allow list.** It restores the conversation and `dontAsk`
  mode, but not `--settings`, so the agent is refused everything not auto-allowed. Text
  typed in its first 0.8 seconds is also lost. v4 starts every session fresh instead.
- **A shell command can't block for long.** After 2 minutes Claude Code moves a command to
  the background and ends the turn, unless the undocumented `BASH_DEFAULT_TIMEOUT_MS` and
  `BASH_MAX_TIMEOUT_MS` are raised. So `skel done` answers at once.
- **The transcript tells a running command from an idle agent.** During a command, the last
  line is an assistant line whose `stop_reason` is `tool_use`, with no result yet, and
  nothing is written until it ends. When the turn ends, the last line is a `turn_duration`
  system line. A command moved to the background looks idle.
- **Never send `ctrl+b`.** Pressed twice, it moves Claude Code's running command to the
  background, and it is also tmux's prefix key.
- **Subfolders inherit folder trust**, so a worktree inside a trusted repository needs no
  prompt.
- **Claude Code outlives `tmux kill-server` by a few seconds.** Wait for its processes to
  exit.

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

## Core lessons

v3's core (`src/core/`) is the decider pattern done carefully. Most of these were found by
its property tests or by Codex review, and each was a real bug.

**Shape**

- **`decide` reads as an outline.** Create, then refuse a missing task, then clean up late
  replies, then refuse an ended task, then refuse the wrong sender, then inputs that work in
  any phase, then one function per phase. `evolve` has the same shape.
- **Read a task through one module** (`task.ts`): which session is running, which request
  the step waits on, what it waits on you for. Each question has one answer, shared by
  decide, the scheduler and the tests.
- **Helpers named for a problem return the reason or null**, such as `senderMismatch`.
  Rejections are written in plain words, with phase and input names as you would say them.

**Bugs worth not repeating**

- **Build every phase change from the base fields.** Moving phase by spreading the old task
  carried old fields into the new phase. TypeScript can't catch it, since spreads skip its
  check for extra fields. The property test checks that a task carries exactly its phase's
  fields.
- **An event that sends a request carries its number.** `evolve` records the number from
  the event, never works it out, and `decide` picks it in one place. When the two counted
  separately, replies could stop matching.
- **Clean up only what the task doesn't hold.** A repeated reply for the session or
  workspace the task already holds is ignored. Cleaning it up stopped the working agent and
  removed its worktree.
- **A crash can arrive before the start reply.** The end report names the request that
  started the session. If the task still waits on that request, it counts as a failed
  start, and the late start reply is cleaned up.
- **A verdict belongs to its round.** A review result from an earlier round once passed the
  current one, so new code shipped without its own review. Every result must answer the
  current request.
- **Pin the exact commit.** A repeated done report once replaced a newer one, and a
  critical file merged without approval. The commit, and the files it changed, are fixed
  when the work is handed over, and everything after uses them.
- **A question goes when its agent goes.** A question once outlived its agent, and every
  answer was refused. An agent also can't hand over while its own question is open.
- **Check the budget on every usage report and before every start.** A report that arrived
  while an agent was starting was only recorded, and the task ran past its cap.
- **Count starts in flight outside the task.** A task dropped while its agent was starting
  freed its slot at once. The loop counts starts, since a task can't keep a marker once it
  has ended.
- **`evolve` refuses an event that doesn't fit**, naming it, so a damaged log stops replay
  instead of rebuilding a wrong task.

**Testing**

- **Guided random inputs.** Most steps pick an input the task accepts right now, so random
  runs reach every phase. Inputs that move a task backwards come only from unguided picks,
  or they crowd out progress.
- **Replies are built from the requests actually sent**, old ones included, so late and
  repeated replies are tested all the time.
- **Check both directions.** Every live agent and workspace is held by its task, and
  everything a task holds is really live. v3's first property test checked only one
  direction, and repeated replies slipped through.
- **Golden stories**: whole lifecycles as input sequences, with their events saved as
  snapshots, so any change to the event log shows up in review.

## What v3 never built

The reviewer, stall detection and resuming a harness session. The spike above tested the
last two and a long-blocking `done`, and v4 now avoids all three. The tester is still new in
v4, with nothing from v3 to lean on.

## Where v3's complexity went

Most of v3's code beyond the core served things v4 drops: merging and merge approval,
treating a merge on GitHub as approval, revert, attended claims from your own harness,
projects, and the basic runner. v4's core can be much smaller. The daemon around it can't
be: slot accounting, recovery and the outbox are real work in any version.
