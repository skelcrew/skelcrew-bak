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

## Milestone 3: daemon and CLI

A draft, for review before any of it is built. In order, each one usable by the next.

- [ ] **Config.** Read `skelcrew.yaml` and check it with Zod: roles, repo commands, critical
      paths and limits. A bad file is refused with what is wrong and where.
- [ ] **Protocol.** The messages between `skel` and the daemon, versioned and checked with
      Zod on both sides: a request, and an answer of accepted or rejected with the reason.
- [ ] **One daemon per repository.** `skel serve` takes an `flock`, opens the store, reopens
      the loop and listens on a local socket. A second daemon for the same repository
      refuses to start.
- [ ] **The tick.** Requests and tool replies are handled one at a time. Every few seconds
      the daemon calls `retryReplies` and `startWaiting`.
- [ ] **Fake tools in the daemon.** Workspaces, sessions and merges faked behind the tools
      interface, shared with the simulator rather than copied. Milestone 4 replaces them
      with git and tmux.
- [ ] **Who is calling.** Each session gets a secret token. A request carrying one is
      mapped to its task, role and phase, and anything outside them is refused. No token
      means you.
- [ ] **Your commands.** `skel add`, `ls`, `set`, `reply`, `approve`, `deny`, `pause`,
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
