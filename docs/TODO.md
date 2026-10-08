# To do

The tasks for the current milestone in `docs/ROADMAP.md`, roughly in order. Tick a task in
the commit that finishes it. When a milestone is done, its tasks go, and the next one is
split into tasks here.

## Open from the core

- [ ] Review the design calls in `docs/core.md`, "Decisions made while building the core".
- [ ] Decide on `AGENTS.md`'s rule that an agent working alone doesn't change the core.
- [ ] Reconcile the spec's "the reducer is a few hundred lines" with `decide.ts` at about
      1,200, by changing the promise or splitting the code.
- [ ] Decide on `output.failed` and `task.failed`. Both are event types, but nothing in the
      core produces them, so no saved log can hold one yet. Either the core starts producing
      them, or they go.
- [ ] Before dogfooding freezes the saved-events fixture, add the event types it lacks:
      `main.failed`, `session.ended` and `spec.requested`. Found by Fable.

## Core bugs from the full review, for a live session

Found by Codex and Fable before milestone 3. They change what the core decides, so they wait
for you. The first three are proven by a script that walks the core through them.

- [ ] **Approval lost after a failed spec commit.** Set approval while the task is held after
      the spec commit failed: it is accepted but never applied, so the task ships without
      your sign-off (rule 8). Intent and rigor set then are lost the same way.
- [ ] **Kill while a session starts.** The late session is stopped with no request, so its
      stop is never confirmed and the worktree is never removed. A retried task can also
      start a builder before the late one has stopped (rule 10).
- [ ] **Kill during a merge or spec commit** removes the workspace while git still works in
      it, which can lose uncommitted work. One fix is for kill to wait, like pause, but
      `docs/core.md` says kill always works. Your call.
- [ ] **Kill after a builder crashed** removes its workspace without saving its edits
      (rule 15). Found by Codex, not yet proven.
- [ ] **An attached task still moves on** when its agent reports done or pass, though the
      spec says the loop leaves it alone until you detach. Found by Codex.
- [ ] **Rebuilding from the log accepts events that don't fit**, such as delivered right
      after received, so a damaged log builds a wrong task instead of stopping. Found by
      Codex.
- [ ] **Triage accepts an empty brief, and a spec for light work** (spec, Triage rules).
      Found by Codex.
- [ ] **A retried builder isn't told why it was held.** The reason is gone once the hold
      clears. Found by Codex.
- [ ] **`detach hand_over` skips the checks `done` makes**, such as an empty branch. Found
      by Fable.
- [ ] **The loop doesn't check a reply against its command.** A null or wrong-request reply
      retires the command and leaves the task waiting forever. Not the core, so it is
      fixed in milestone 3.

## Milestone 3: daemon and CLI

A draft, for review before any of it is built. In order, each one usable by the next.

- [x] **Config.** Read `skelcrew.yaml` and check it with Zod: roles, repo commands, critical
      paths and limits. A bad file is refused with what is wrong and where.
- [x] **Protocol.** The messages between `skel` and the daemon, versioned and checked with
      Zod on both sides: a request, and an answer of accepted or rejected with the reason.
- [x] **One daemon per repository.** `skel serve` takes an `flock`, opens the store, reopens
      the loop and listens on a local socket. A second daemon for the same repository
      refuses to start.
- [x] **The tick.** Requests and tool replies are handled one at a time. Every few seconds
      the daemon calls `retryReplies` and `startWaiting`.
- [x] **Fake tools in the daemon.** Workspaces, sessions and merges faked behind the tools
      interface, shared with the simulator rather than copied. Milestone 4 replaces them
      with git and tmux.
- [x] **Who is calling.** Each session gets a secret token. A request carrying one is
      mapped to its task, role and phase, and anything outside them is refused. No token
      means you.
- [x] **Your commands.** `skel add`, `ls`, `set`, `reply`, `approve`, `deny`, `pause`,
      `resume`, `start`, `retry` and `kill`, each answered at once. `attach`, `path` and
      `open` need real sessions and workspaces, so they wait for milestone 4.
- [ ] **Agent commands.** `skel triage proceed|ask|split|decline`, `ask`, `progress`, `done`,
      `give-up`, `pass` and `changes`. A file argument, such as a brief, is read by `skel`
      and sent as text.
- [ ] **Start on demand.** Any `skel` command starts the daemon if none runs, and waits until
      it listens.
- [ ] **Walkthrough test.** One task driven from `skel add` to delivered through the real
      socket, with a test standing in for each agent by its token. This is the milestone's
      "done when".
- [ ] **Simulator: your inputs at random.** Pauses, kills, questions and answers, and tool
      replies that arrive late, in the loop's property test.
