# Architecture

A short guide to reading the code. The design is in `docs/spec.md`, the core in words is in
`docs/core.md`, and the rules it must never break are in `docs/invariants.md`.

Parts marked _planned_ don't exist yet.

## The parts

| Part | Folder | What it does |
|---|---|---|
| Core | `src/core/` | Pure functions. `decide` judges one input against one task, `evolve` applies events, and `schedule` picks what gets a free slot. `task.ts` answers questions about a task in one place. No clock, disk or network. |
| Loop | `src/loop/` | Runs each input through the core, saves events and commands together, then hands the commands to the tools. Reopens from the store after a restart. |
| Store | `src/store/` | The event log and the outbox in SQLite, every row checked by Zod when written and read. |
| Simulator | `src/sim/` | The loop with fake tools and scripted agents, so whole lifecycles run in tests. |
| Daemon | `src/daemon/` | One per repository, held by a lock. Holds the loop, answers the CLI over a local socket, and carries out commands through the plugins. |
| Protocol | `src/protocol/` | The versioned messages between the CLI and the daemon, checked by Zod on both sides. |
| Config | `src/config/` | Reads `skelcrew.yaml`, checked by Zod. |
| CLI | `src/cli/` | `skel`, for you and for agents. Holds no state, and starts the daemon if none runs. |
| Plugins | `src/plugins/` _planned_ | The harness (Claude Code), the session runner (tmux), git, and outputs. |
| Checks | `src/checks/` | The test watchdog, which stops a hung test run. |

## How one input flows

An agent runs `skel done`. The CLI sends it to the daemon, which adds the facts from git and
passes it to the loop. The loop asks `decide`, saves the events and commands it returns in
one transaction, applies the events with `evolve`, and hands the commands to the plugins.
Their replies come back as new inputs, through the same loop.

## Where to start reading

1. `docs/core.md`, for what a task is and how it moves.
2. `src/core/types.ts`, top to bottom.
3. `decide`, from its top-level outline, then `evolve`.
4. The tests next to them. `stories.test.ts` shows whole lifecycles, and
   `invariants.test.ts` checks every rule in `docs/invariants.md` against random ones.
