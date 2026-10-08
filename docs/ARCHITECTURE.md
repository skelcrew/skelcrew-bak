# Architecture

A short guide to reading the code. The design is in `docs/spec.md`, the core in words is in
`docs/core.md`, and the rules it must never break are in `docs/invariants.md`.

Parts marked _planned_ don't exist yet.

## The parts

| Part | Folder | What it does |
|---|---|---|
| Core | `src/core/` _planned_ | Pure functions. `decide` judges one input against one task, `evolve` applies events, and the scheduler picks what gets a free slot. No clock, disk or network. |
| Loop | `src/loop/` _planned_ | Runs each input through the core, saves events and commands together, then hands the commands to the tools. |
| Store | `src/store/` _planned_ | The event log and the outbox in SQLite. |
| Daemon | `src/daemon/` _planned_ | Holds the loop, answers the CLI over a local socket, and carries out commands through the plugins. |
| CLI | `src/cli/` _planned_ | `skel`, for you and for agents. Holds no state. |
| Plugins | `src/plugins/` _planned_ | The harness (Claude Code), the session runner (tmux), git, and outputs. |
| Checks | `src/checks/` | The test watchdog, which stops a hung test run. |

## How one input flows

An agent runs `skel done`. The CLI sends it to the daemon, which adds the facts from git and
passes it to the loop. The loop asks `decide`, saves the events and commands it returns in
one transaction, applies the events with `evolve`, and hands the commands to the plugins.
Their replies come back as new inputs, through the same loop.

## Where to start reading

1. `docs/core.md`, for what a task is and how it moves.
2. The core's types, once they exist.
3. `decide`, from its top-level outline.
