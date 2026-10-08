# Roadmap

The milestones, in order. Each one gives you something you can use or see working, and
says when it is done. The design is in `docs/spec.md`. When a milestone starts, it is split
into tasks in `docs/TODO.md`.

## Done

### 1. Core

The rules, as pure code: `decide`, `evolve` and `schedule`.

Done when every core rule in `docs/invariants.md` holds under property tests, and whole
lifecycles are snapshotted as golden stories. Reviewed by Codex and Fable.

### 2. Store and loop

Decisions survive a crash. The loop runs each input through the core, saves events and
commands in one SQLite transaction, and carries the commands out. Reopening resends what
didn't finish.

Done when the simulator runs whole lifecycles with fake tools, and a property test kills
the loop at random moments and finds every task as it was. Reviewed by Codex and Fable.

## Next

### 3. Daemon and CLI — current

You drive Skelcrew from a terminal. `skel add`, `skel ls` and the rest reach one daemon per
repository over a local socket, which starts if none runs. Agents get their own commands,
known by their session token. The tools are still fakes.

Done when a task can be walked through its whole life with `skel` commands, standing in for
the agents by hand. The simulator then also sends your inputs at random (pauses, kills,
questions and answers) and delays tools' replies, which milestone 2's property test leaves
out.

### 4. First real task

Real agents do the work. Git makes worktrees, the tester's copy and the branch, tmux holds
the sessions, and Claude Code runs each role with its own permissions and protocol preamble.

Done when one real task goes from `skel add` to a branch on this repository: planner,
builder, tester, delivered. On a restart, the daemon finds its sessions again in tmux,
reports those that ended while it was down, and stops any it doesn't know, as the spec's
recovery says.

### 5. Skelcrew builds itself

Every change to Skelcrew goes through Skelcrew. v3 is frozen. Whatever gets in the way of
daily use is fixed first.

Done when a week of Skelcrew's own work has gone through it, and nothing made you go around
it.

### 6. Measured

Skelcrew shows how well it works for you: questions per task, minutes you spent on
decisions, how often the tester catches a problem, tasks done without you, and cost per
task.

Done when those numbers are shown, and the budget, stall and loop limits that the spec
leaves as placeholders are set from them.

### 7. GitHub issues in

Labelling an issue `crew` adds it as a task. Questions and status go to the issue, and your
reply there answers, from your own accounts only.

Done when a task can be added, asked about and answered without leaving GitHub.

### 8. GitHub pull requests out

A finished `ship` task opens a pull request at exactly the reviewed commit, with the
evidence in its description. Auto merge can be switched on, and branch protection still
decides.

Done when this repository's own changes arrive as pull requests.

### 9. TUI

One screen for what waits on you and what is running: answer, approve, pause, start and
attach with a key.

Done when you no longer need `skel ls` for daily use.

### 10. Notifications

What waits on you reaches you when you're away from the terminal.

Done when you hear about a question or a sign-off within a minute.

### 11. herdr

Sessions can run in herdr instead of tmux, through the same session runner contract.

Done when the runner contract tests pass for herdr, and a task runs end to end in it.

## Later

Not yet ordered. Each becomes a milestone when its turn comes.

- **Codex as a harness**, so a role can run on Codex.
- **Container isolation (`local`)**, where the rules are enforced by what an agent can reach.
- **Remote isolation**, so agents keep working while your laptop is closed.
- **Handoffs**: bring a branch you started into Skelcrew for review and delivery.
- **More trackers**: Linear and Basecamp.
- **Errors in**: new or regressed errors from an error tracker become tasks.
- **Preview deploys out.**
- **Chat channels**: Slack or OpenClaw for questions and answers.
- **Remote clients** over the same protocol.
- **Agent-maintained skills.**
- **Configurable intent and rigor.**
- **Teams.**
