# Skelcrew spec

## Summary

Skelcrew runs coding agents in parallel, always on and unattended. Plugins connect it to the tools you already use, from GitHub and your tracker to Slack and monitoring. Each task is triaged, built and reviewed by separate agents in isolated workspaces, and a deterministic decider with an append only log makes every step trustworthy and auditable. You make decisions; you don't supervise.

Skelcrew is plumbing. It does not try to make agents smarter. It starts vanilla harnesses (Claude Code, Codex) with a task and a role, keeps track of what is happening, and hands finished work to the tools that already own the rest of the workflow.

## Core concepts

1. **Parallel, always on, unattended.** The goal. Several coding agents work at once, keep working while you're away, and don't need watching.
2. **I/O.** What unattended requires. Work comes in from where it's tracked, and questions, approvals and results reach you wherever you are. Unattended means tasks, not chat.
3. **Plugins.** How Skelcrew sits in the middle of your chosen dev tooling instead of replacing it.
4. **Phases and roles.** How work gets judgment and checking without a human in the loop. Every task is triaged, built and reviewed, by planner, builder and tester.
5. **Workspaces with isolation.** Where agents work, and what keeps them inside the rules.
6. **A deterministic decider and an append only log.** What makes unattended trustworthy. Every transition follows the rules, and everything that happened can be replayed and audited.
7. **You make decisions, not supervision.** Direction, questions and approvals reach you. Babysitting and routine diffs don't.

## Premises and principles

- **Models improve faster than anyone can tinker around them.** Anything built to compensate for today's model weaknesses becomes dead code. Plumbing for the human does not. The test for every feature: if the next model is twice as good, does this become dead code? If yes, don't build it.
- **Simple and dumb.** The core knows as little as possible.
- **Small pieces, loosely joined.** Each tool owns one job. Skelcrew is the joints between them.
- **Guarantees in code, judgment in agents.** The agent proposes, the reducer disposes.
- **Enforce by capability, not instruction.** Agents cannot bypass a rule because they never hold the power it protects.
- **Nothing trapped.** Tasks live in the tracker, code and plans in git, transcripts in the harness. Skelcrew stores control state and history.

**Non goals:** a skill library or prompt framework, an IDE or diff viewer, a task manager, merging or deploying code, agent to agent protocols, team features.

## MVP scope

The MVP is what's needed to dogfood: one person, one machine, building Skelcrew with Skelcrew.

**In the MVP**

- Daemon, CLI and the full lifecycle: triage, build, review
- Intents `ship`, `try`, `answer`; rigor `light`, `full`; the approval flag
- Planner, builder and tester on Claude Code
- Worktree workspaces (isolation `none`) with the harness sandbox on
- tmux sessions, with attach
- Local inbox (`skel add`) as the task source; a branch or a report file as output
- Slots, pausing and starting
- Event log in SQLite, recovery after restart

**Right after the MVP**, in order: GitHub (issues in, PRs out, auto merge), the TUI, herdr, notifications.

Everything else is in Later.

## Terms

- **Task**: a unit of work with a source and a source ID (a GitHub issue, or a local task from `skel add`).
- **Phase**: triage, build or review. Always in that order; review is the only optional one.
- **Intent**: what the task produces: `ship`, `try` or `answer`.
- **Rigor**: how much care it gets: `light` or `full`. Plus an **approval** flag for work that needs your sign off.
- **Role**: who works a phase: planner (triage), builder (build), tester (review). A role is a config entry: instructions, harness, model. Skelcrew puts a fixed protocol preamble before your instructions.
- **Workspace**: where an agent works. A git worktree in the MVP.
- **Session**: an interactive harness running in a workspace, inside tmux. Never headless, so you can always attach.
- **Event**: everything that happens to a task, in an append only log. State is derived from events.
- **Plugin**: anything that connects Skelcrew to the outside world.

## Architecture

```mermaid
flowchart TB
    IN["Input plugins<br/>issues, skel add"]
    YOU["You<br/>CLI, TUI, attach"]
    OUT["Output plugins<br/>PR, report, notify"]

    subgraph D["Daemon"]
        direction LR
        SCH["Scheduler<br/>slots, sessions"]
        RED["Reducer<br/>rules, guarantees"]
        STO["Store<br/>event log, SQLite"]
    end

    subgraph W["Workspaces"]
        direction LR
        PL["Planner<br/>triage"]
        BU["Builder<br/>build"]
        TE["Tester<br/>review"]
    end

    IN --> D
    YOU <--> D
    D --> OUT
    D -- "start, message" --> W
    W -- "skel commands" --> D
```

- **The daemon** (`skel serve`) is the only part that holds state or credentials. Any `skel` command starts it if it isn't running.
- **The scheduler** is where orchestration lives: plain code that decides which task gets a slot, which role starts where, and where questions go. There is no supervising agent. The planner comes closest, but it shapes one task once, up front, and hands back data.
- **Clients** (CLI, TUI) talk to the daemon over a local socket and hold no state. Messages are versioned, so the same protocol can later be exposed over the network.
- **Plugins** connect the daemon to the outside world. Agents never talk to the tracker, GitHub or you directly.
- **Agents** get their context when a session starts and act only through `skel` commands. Messages into a session (answers, nudges) go through the session runner.

The reducer is small enough to be a few hundred lines. The daemon around it isn't: slot accounting, recovery and the outbox are real work.

## Queue, not backlog

Adding a task is the commitment: build this. Skelcrew is an orchestration tool with guardrails, not a project management tool.

- **The backlog lives elsewhere.** In your tracker, or wherever you keep ideas. Labeling an issue `crew` or running `skel add` is the decision.
- **There is still a queue.** When more tasks arrive than `max_running` allows, they wait and start in order.
- **No priorities in Skelcrew.** Order comes from when tasks are added.
- **Proposals are not tasks.** Tasks proposed by a split or an answer only enter the queue when you approve them.
- **Removing a task is a decision**: `skel kill`.

## Slots, pausing and starting

`max_running` sets how many agents work at once. A running task holds one slot. A task waiting on you, with you, or paused holds none.

- **Pause** (`skel pause 142`): the agent stops, Skelcrew commits any uncommitted work, and the workspace and harness session are kept. The task frees its slot and never restarts on its own.
- **Resume** (`skel resume 142`): the task goes to the front of the queue, continuing its harness session where it left off.
- **Start now** (`skel start 145`): starts immediately if a slot is free. If not, `skel start 145 --pause 142` swaps them atomically, so running agents never exceed `max_running`.
- **Order**: answers to questions first, then resumed tasks, then queued tasks. Oldest first within each.
- **Starts and stops in flight hold a slot.** A session that has been asked to start holds its slot from the request, not from when it reports in. A session being stopped holds its slot until the stop finishes. Starts in flight are stored, so a restart still counts them.

## Task lifecycle

```mermaid
flowchart LR
    IN["Task in"] --> TR["Triage<br/>planner"]
    TR --> BU["Build<br/>builder"]
    BU --> RE["Review<br/>tester"]
    RE -- "changes requested" --> BU
    RE --> DONE["Done<br/>branch, PR, report"]
    BU -- "try" --> DONE
    TR --> END["Ends early<br/>split, decline"]
```

**Phases**

- **Triage** (planner): decide intent and rigor, write the brief, and a spec when needed.
- **Build** (builder): do the work. What happens inside is the builder's judgment: investigate before fixing a bug, plan briefly before a feature, spike fast for a prototype.
- **Review** (tester): code review and verification. Skipped for `try`. Requested changes go back to build, up to the loop cap.

**Side states**, possible in any phase: **waiting on you** (a question or approval), **with you** (you attached), **paused**. The task resumes in the same phase.

**Endings**: **done** (output handed over), **split** (replaced by proposed tasks), **declined** (handed back with a reason), **killed**, **failed**.

Anything that comes back after done (PR feedback, a production bug) is a new task. Nothing leaves an ending.

## Intent and rigor

Every task gets two small decisions instead of a list of modes. Their behaviour is fixed in the MVP, not configurable.

### Intent: what the task produces

| Intent | Produces | Edits code? | Mergeable? | Review |
|---|---|---|---|---|
| `ship` | a change that goes to production | yes | yes | yes |
| `try` | a prototype on a branch, plus findings | yes | never | no |
| `answer` | a report, optionally with proposed tasks | no (read only) | n/a | yes |

`answer` covers questions about the codebase (why is search slow?), about ideas (what are our options for offline sync?) and designs (how should the export UI work?). If the answer implies work, it proposes tasks rather than starting any.

### Rigor: how much care it gets

| Rigor | Triage | Review |
|---|---|---|
| `light` | brief only | a quick check: of the code for `ship`, of the report for `answer` |
| `full` | brief, plus a spec when the planner judges one needed | code review and verification for `ship`; for `answer`, the report's claims checked against the code |

**Approval** is a flag, not a level. It means the task waits for your sign off after review, before anything is handed over. The planner sets it for critical work (auth, payments, migrations, or paths listed as `critical` in config), and you can set it with a label or `--approve`.

### Common combinations

| You'd call it | Intent | Rigor |
|---|---|---|
| quick fix | ship | light |
| bug fix, feature | ship | full |
| security fix | ship | full + approval |
| prototype | try | light |
| investigation, research, design | answer | light or full |

Bug versus feature doesn't change the workflow: a bug just means the builder investigates first.

### What the reducer enforces

- `try` never produces a mergeable output.
- `answer` runs with read only harness permissions, so it can't change code.
- `ship` never reaches done without `review.passed`.
- A task with the approval flag never reaches done without your sign off.

## Triage

Every task starts with triage: a short, cheap run by the planner. It's skipped only when you set intent and rigor yourself.

### Output

Triage ends with one `task.triaged` event, with one of three outcomes:

- **proceed**: here's the intent, rigor and brief
- **split**: really several tasks; proposals go to you, the original ends
- **decline**: not now or not needed; handed back to the tracker with a reason you can overrule

The planner can also **ask** when the task is too vague. That doesn't end triage: it emits `question.asked`, and the planner continues once you answer.

For proceed:

```yaml
outcome: proceed
intent: ship        # ship | try | answer
rigor: full         # light | full
approve: false
brief: |
  Export crashes when a report has no rows.
  Likely in the CSV writer's header handling.
  Done when empty reports export a header-only file.
spec: docs/plans/142-empty-export.md   # only when the planner judged one needed
```

### Rules

- **The brief is always there.** The builder starts from it and the tester checks against it: the task restated, a hint of where to look, what done means.
- **A spec is optional**, written by the planner during triage for big or ambiguous work, so build is purely building. Never for `light`.
- **The decision is visible** in `skel ls`, the TUI and as an issue comment, so a wrong call is easy to fix early.
- **Override**: `skel add --ship --light "Fix button color"` skips triage; `skel set 142 --rigor full` changes it and restarts from build.

## Review

The tester works in its own workspace, checked out from the commit the builder handed over, so nothing the builder does afterwards can change what was checked. It is a detached worktree (`git worktree add --detach`) at that commit, since git won't check out the task's branch twice. Skelcrew removes it once the verdict is in.

- **Code review**: an adversarial read against the brief and spec. A change can pass every test and still be unsound.
- **Verification**: run the project with the repo's `setup` and `test` commands, and collect evidence that it works (test results, and screenshots or a preview where it applies). A failing command fails review.

The verdict goes through the daemon. The evidence is part of what done hands over: in the PR description for `ship`, alongside the report for `answer`.

**The checks run the branch's own code.** `setup` and `test` come from config, but `bun test` runs whatever scripts and test files the branch holds, so a builder could make its own checks pass. The tester treats a change to tests, test scripts or check config as something to review closely, and says so in its findings.

## Workspaces

A workspace always holds a checkout of the repo on the task's branch, read only for `answer`. Skelcrew treats every workspace the same: create, start a session, attach, run commands, stop, remove.

**MVP: worktrees, isolation `none`.** The harness runs as you on your machine. Two things add some protection:

- **The harness's own sandbox** (limiting shell commands' file and network access) is on by default.
- **Agents get no credentials of their own.** Without a container they may still find yours on disk, so this is a speed bump, not a wall.

**Permissions per role.** Every session starts with the harness in a mode that refuses anything that would ask, since nobody is there to answer, plus an explicit allow list. For Claude Code that is `--permission-mode dontAsk` and `--settings` with:

- **planner, tester, and any role on an `answer` task**: `skel` commands only, plus the repo's `setup` and `test` commands for the tester. No file edits.
- **builder**: also edits inside its own worktree, `git add` and `git commit`. A commit with `--no-verify` is denied.

This is how "`answer` never starts a session with edit permissions" holds by capability rather than instruction.

**Folder trust stays yours.** Before starting a session, Skelcrew checks that the harness already trusts the repository. It never grants trust itself. If the repository isn't trusted, the session isn't started, and you're told how to fix it.

Under `none`, the rules hold for agents that use Skelcrew's protocol, but an agent that goes around Skelcrew can do anything you can. The TUI says so. Real enforcement comes with the `local` (container) and `remote` isolation levels in Later.

## Sessions

A session is a harness running interactively in a workspace, inside tmux. The session runner (tmux) and the harness profile (Claude Code) split the work: the runner holds terminals, the profile knows the harness.

- **Start.** Skelcrew picks the harness session ID up front (`claude --session-id <uuid>`) and stores it on the task. The transcript, usage and resume are all found through it. The session gets `SKELCREW_SESSION` and `SKELCREW_TASK` in its environment. Claude Code's own child session variables are removed, or it writes no transcript.
- **tmux.** Skelcrew runs its own tmux server per repository (`-L skelcrew-<hash>`, `-f /dev/null`), so your own tmux setup is never touched. Panes stay after their process exits (`remain-on-exit`), so Skelcrew can read the exit code and the last lines of output. After a restart, the daemon finds its sessions again with `list-panes -a`.
- **Attach.** `skel attach 142` attaches to the session with `ctrl-]` bound to detach.
- **Messages in** (answers, nudges). The runner types the text literally (`send-keys -l`), then sends Enter on its own. The Claude Code profile wraps the text in bracketed paste marks, after stripping control codes; otherwise Claude Code treats a long message as a paste, and Enter only adds a new line. A trailing `;` is escaped, or tmux reads it as a command separator.
- **Stop.** SIGTERM to the pane's process group, then SIGKILL, then the tmux session is killed. Before a stop for pause or kill, before merging main in, and before removing a workspace, Skelcrew commits any uncommitted work itself (`git add --all` and a commit), so no work is lost.
- **Resume.** A paused session comes back with `claude --resume <uuid>` in the same workspace, so it keeps its context. A crashed session is retried with a fresh session instead (see Failure handling).
- **Usage.** The profile reads the transcript (`~/.claude/projects/*/<uuid>.jsonl`). Tokens are input, output and cache writes, counted once per message; cache reads are kept separately, since they would swamp the rest. Working minutes count from each prompt to the agent's last line before the next one, so waiting time doesn't count. Usage is read every few minutes and when a session ends.
- **Activity.** The transcript is also the activity signal: a session with no new transcript line for 20 minutes, and no open question, has stalled.

## Agent protocol

Agents talk to Skelcrew only through the CLI. Each command is a proposal; the reducer accepts or rejects it with a reason.

```
# planner
skel triage proceed --intent ship --rigor full [--approve] --brief brief.md [--spec spec.md]
skel triage ask "Should archived items be included?" [--option yes --option no]
skel triage split tasks.md
skel triage decline "Already fixed in #131"

# builder
skel ask "Keep the old export format too?" [--option ...]
skel progress "Found the cause: header row skipped when empty"
skel done --summary summary.md                   # ship, try
skel done --report report.md [--tasks tasks.md]  # answer
skel give-up "Needs credentials I don't have"

# tester
skel pass --evidence evidence.md
skel changes findings.md
```

- **Who is calling.** Each session gets a secret token in an environment variable. The daemon maps it to a task, role and phase, and refuses anything outside them: a builder can't pass its own review. No token means the human. (Not a lock under `none`, see Workspaces.)
- **One open question per task.**
- **A fixed protocol preamble per role.** Each session starts with a preamble that ships with Skelcrew, followed by your short instructions for that role from config. The preamble describes the interface, not how to do the work:
  - the `skel` commands the role has, and that nobody is watching the session
  - every wait for you goes through `skel ask`, whether a question or something you must do first; a request written into the conversation reaches nobody
  - one question at a time, with options, the recommended one first; your answer arrives as the next message in the session
  - commit often (builder)
  - the turn ends only after `done`, `give-up`, `ask`, or a refusal that says to stop

  It passes the twice-as-good test, since it describes the interface rather than compensating for a weaker model. It is versioned with Skelcrew and not configurable.
- **Short replies**, like chat messages.
- **Commands answer at once with accepted or rejected**, except `done`.
- **`ask` doesn't wait for your answer.** It returns once the question is recorded, and the agent ends its turn. Your answer is typed into its session later, once it has a slot again.
- **`done` waits for the outcome:** review's verdict, or done when the intent has no review. So the builder hears the result in its own session, which matters when you're attached and working with it.
- **The session token is not the request number.** The token says who is calling. The request number (see Core model) says which request a reply belongs to.

## Core model

A pure reducer over an event log. Everything that touches the world carries out the commands it returns.

```
decide(state, input, config) -> { events, commands } | { rejected: reason }
evolve(state, event)         -> state
```

- **No hidden inputs.** Time and IDs are passed in, so replay reproduces bugs exactly.
- **Request numbers.** Every command expecting a reply (start a session, create a workspace, merge main, deliver output) carries a number from a counter on the task. A late or repeated reply is refused, so finished work can't hijack a task that has moved on. A late reply is also cleaned up: a session that starts late is stopped, and a workspace created late is removed. A report that a session ended names the session, so an old session's end can't fail the current one.
- **Replay never judges.** Replay runs `evolve` alone, so old events are never judged again by rules that have changed since.

### The loop

The daemon runs every input through the same loop, one input at a time:

1. `decide` accepts or rejects the input.
2. The events, the commands, and which starts the decision sent out or answered are saved in **one transaction**. If the save fails, nothing else happens: the task doesn't change and no command goes out.
3. `evolve` applies the events.
4. The commands go to the tools. Each reply comes back later as a new input.

**The outbox.** Saved commands form an outbox. A command is marked done only when its tool has finished. For a command that expects a reply, that means once the reply has been handled: saved, or refused as late. A reply that can't be saved is sent again until it is.

**Tools are idempotent.** After a crash, a command can go out twice, so a repeat must change nothing. For example, a second "start #142, request 7" starts no second session, and a second "create workspace" gives back the same one.

### Task state

Two rules shape the types:

- **Each phase carries only the data it needs and has its own small step machine, so impossible states can't be written down.** For example, only a task in review has a handed-over commit. Build moves through steps such as queued, creating a workspace, starting a session and running, and each step that waits on a reply holds its request number.
- **Inputs are typed by sender, so an agent can't approve.** Every input comes from you, an agent, a plugin or the daemon itself. An agent's call can only become an agent input, and no agent input approves, answers, sets intent or rigor, or kills.

Besides its phase and step, a task holds its source and source ID, its title, intent, rigor and approval flag once triaged, the brief and spec path, its branch, workspace and session, any side state (waiting on you, with you, paused) or ending, the open question, the build and review loop count, the request counter, and its usage.

### Events

| Event | Meaning |
|---|---|
| `task.received` | a task arrived |
| `task.triaged` | proceed, split or decline |
| `task.set` | you changed intent, rigor or approval |
| `phase.started` | the task entered triage, build or review |
| `workspace.created` / `workspace.removed` | a workspace was made or cleaned up |
| `workspace.failed` | a workspace couldn't be created |
| `session.started` / `session.ended` | a role's harness session started or ended; `ended` carries a reason: `reported`, `stopped` (pause, kill) or `crashed` (ended without reporting) |
| `session.failed` | a session couldn't be started |
| `question.asked` / `question.answered` | an agent asked (including the planner's ask); you answered |
| `session.attached` / `session.detached` | you stepped in or out; `detached` carries your choice: `resume` or `hand_over` |
| `task.paused` / `task.resumed` / `task.started` | you paused, resumed or started a task |
| `build.done` | the builder handed over |
| `main.merged` / `main.conflict` | the branch was brought up to date with main |
| `review.passed` / `review.changes_requested` | the tester's verdict |
| `approval.given` / `approval.denied` | your sign off |
| `proposals.approved` / `proposals.denied` | your call on tasks proposed by a split or an answer; each approved one arrives as its own `task.received` |
| `output.delivered` | the output plugin confirmed; the task is done |
| `output.failed` | a delivery attempt failed; retried with backoff |
| `agent.stalled` / `agent.nudged` | a session went quiet; it got its one nudge |
| `limit.reached` | a retry, loop cap or budget ran out; the task waits on you |
| `task.killed` / `task.failed` | you stopped it, or you gave up on it after a limit was reached |

Events are versioned from day one.

### Invariants

Property tested, and approved before implementation:

- Replaying the log always yields the same state.
- Rejected inputs and replies with the wrong request number never change state.
- `ship` never reaches done without `review.passed`.
- A task with the approval flag never reaches done without `approval.given`.
- `try` never produces a mergeable output.
- `answer` never starts a session with edit permissions.
- A task has at most one running session and one slot.
- Running tasks never exceed `max_running`, including during a swap.
- A paused task never restarts without you.
- No workspace or session is ever left untracked.
- Every saved command is carried out at least once, and carrying it out twice has the effect of once.
- A failed save changes nothing: no state change, no command sent.
- Nothing leaves an ending.

## Keeping up with main

Before review, the daemon merges main into the task branch, in the builder's worktree, after committing any uncommitted work. On a conflict the merge is left unfinished for the builder to complete, so the tester always checks against current main. After done, the PR and CI handle drift. Skelcrew never force pushes.

## Failure handling

- **Crash** (session ends without reporting): one automatic retry with a fresh session, then waiting on you.
- **Stall** (no new transcript line for 20 minutes, with no open question): one nudge, then waiting on you.
- **Loop cap** (3 build and review round trips): waiting on you, with the tester's findings.
- **Budget** (working minutes, counted only while an agent works): waiting on you. Placeholders until dogfooding: 30 minutes for `light`, 2 hours for `full`.
- **Workspace or session fails to start**: one retry, then waiting on you.
- **Output delivery fails**: retried with backoff; the task is done only when delivery is confirmed.

Every failure that reaches you says what happened in one line and offers the actions that fit.

## Storage

SQLite on the machine running the daemon.

- **Stored:** the event log, the task projection derived from it, the outbox of commands not yet carried out, the starts in flight, the sessions Skelcrew started, and mappings from source IDs to workspace, session, branch and PR.
- **Not stored:** tasks themselves (tracker or local inbox), code and specs (the repo, specs in `docs/plans`), transcripts (the harness; Skelcrew keeps a pointer, which is what makes resume work), secrets (environment or keychain).

**One daemon per repository.** The daemon holds an operating system file lock (`flock`) while it runs. The lock ends with the process however it ends, so two daemons never run the same log, and no PID file is trusted.

**Recovery.** On restart, in this order:

1. **Rebuild** every task by replaying the log through `evolve`. An event that can't be read or doesn't fit stops the start with its position, rather than rebuilding a wrong task.
2. **Resend** every command in the outbox that wasn't marked done, including one whose work was still going on when the daemon died. The tools treat a repeat as a no-op.
3. **Count starts in flight** from the store, so slots stay right before any reply arrives.
4. **Find the sessions.** The runner lists the sessions still open. A session that ended while no daemon ran is reported with its real exit code. A recorded session the runner no longer has is reported as ended (`crashed`, "Skelcrew restarted"). Both then go through normal crash handling (see Failure handling). A session the runner has but the store doesn't is stopped.
5. **Run the scheduler.**

Losing the database loses control of in flight tasks and history, never work.

## Plugins

| Event | Direction | Example |
|---|---|---|
| `task.in` | input → core | `skel add`, an issue labeled `crew` |
| `answer.in` | input → core | a reply to a question |
| `question.out` | core → output | an issue comment, a notification |
| `status.out` | core → output | a label or comment mirroring progress |
| `work.out` | core → output | a branch, a PR, a report |
| `decline.out` | core → output | remove the `crew` label with a reason |

Plugin kinds: task sources, outputs, harnesses, workspaces, session runners, notifications.

**GitHub output** (right after the MVP): on done, open a PR from the reviewed branch with the evidence in its description. With `auto_merge: true` (off by default) it enables GitHub's auto merge but never merges directly; branch protection, CI and CODEOWNERS decide what lands.

## Human interface

Everything important reaches you through notifications and the tracker. The CLI and TUI are conveniences.

### Workflow

1. Add a task (`skel add`, or label an issue).
2. The planner triages it. Several tasks run in parallel.
3. If an agent must ask, you get the question and reply in one line.
4. Builder and tester loop until the work passes, with evidence.
5. Done: a branch or PR (auto merged if allowed), or a report.
6. When something feels off, attach and talk to the agent directly.

### CLI

```
skel add "Fix button color on settings"   # new task; --ship/--try/--answer, --light/--full, --approve skip triage
skel ls                                    # tasks, phase, intent and rigor
skel set 142 --rigor full                  # change intent, rigor or approval; restarts from build
skel reply 142 "No, skip archived items"   # answer a question
skel approve 142 / skel deny 142 "why"     # sign off on a flagged task, or on proposed tasks
skel attach 142                            # enter the agent's session
skel path 142                              # print the worktree path: lazygit -p $(skel path 142)
skel open 142                              # shell in the worktree
skel pause 142 / skel resume 142
skel start 145 [--pause 142]
skel kill 142
```

### TUI (right after the MVP)

A glance and act surface, not a workspace.

```
skelcrew   3 running · 4 slots
─────────────────────────────────
NEEDS YOU (2)
 ? Archived items in export?
   #142 ship · full · build · 3m
 ✓ Approve: auth token refresh
   #138 ship · full · approve

RUNNING (3)
 ● #145 Fix button color
   ship · light · build · 2m
 ● #140 Search index
   ship · full · review · loop 2

PAUSED (1) · QUEUED (2) · DONE TODAY (5)
─────────────────────────────────
a attach  r reply  p pause  ⏎ start
```

Needs you first; if that section is empty, close the TUI. One quiet line per task, no log firehose. Selecting a task shows its brief, timeline, last agent activity, tester findings and evidence.

### Chat mode

Entering chat mode is attaching to the task's session.

- The task moves to with you; the loop leaves it alone.
- Detaching does one of two things, which you choose: **resume** hands the task back to its phase, where the agent carries on; **hand over** treats the work as handed over (as if the builder ran `skel done`), so it moves to review, or to done when the intent has no review. Approval still applies.
- The conversation is part of the task's history.
- If the session has ended, the harness's resume reopens it with full context.

### Inspecting work

Skelcrew doesn't show diffs. `skel path` and `skel open` take you to the worktree, where lazygit, nvim or anything else works, including on uncommitted changes. Builders use predictable branch names (`skel/142-json-export`) and commit often. Editing alongside an agent needs no special handling; to stop it, attach or pause.

Watching diffs is optional: the tester's findings and evidence are the default way of knowing what happened.

## Configuration (MVP)

```yaml
# skelcrew.yaml
# Each role's instructions follow Skelcrew's fixed protocol preamble (see Agent protocol).
roles:
  planner:
    harness: claude
    model: fast
    instructions: |
      Decide intent and rigor, set approve for critical work,
      write a brief of a few lines, and a spec only when needed.
      Ask, split or decline when proceeding isn't right.
  builder:
    harness: claude
    instructions: |
      Do the work the intent asks for. Commit often.
      Ask only when a decision is genuinely the human's.
  tester:
    harness: claude
    instructions: |
      Review the change adversarially against the brief,
      then run it and collect evidence that it works.
      Pass with evidence, or request changes.

repo:
  setup:    [bun install --frozen-lockfile]
  test:     [bun test, bun run typecheck]
  critical: [src/auth/**, migrations/**]

limits:
  max_running: 4
```

## Build plan

Start over rather than rewriting v3, but carry its lessons.

1. **Test the unknowns first.** v3 never built resume, the tester, or stall detection, so nothing has tested them. Before building on them, check with throwaway scripts that a resumed harness session keeps its permissions and takes a typed message, that `done` can wait as long as a tester agent runs, and that the transcript tells a working agent from a stalled one. The answers can change the core's events and steps.
2. **Core, attended.** Types, events and invariants approved first, then the reducer with a test per transition, property tests, and a simulator that runs whole lifecycles with scripted replies.
3. **Smallest real loop.** `skel add` → planner → builder in a worktree with tmux → tester in its own worktree → a branch.
4. **Dogfood.** The MVP builds the rest of Skelcrew. v3 is frozen.
5. **Right after the MVP:** GitHub, the TUI, herdr, notifications.

Track from step 4: questions per task, minutes spent on decisions, tester catch rate, tasks reaching done without you, cost per task.

## Later

- **Isolation levels** `local` (a container on your machine) and `remote` (another box), where enforcement by capability becomes real and agents keep working while your laptop is closed.
- **More plugins**: Codex and pi as harnesses (pi's RPC mode allows steering without typing into terminals), Linear and Basecamp as trackers, an error tracker as input (deduped, new or regressed errors only, with a brake against fix loops), preview deploys as output, OpenClaw or Slack as channels.
- **Remote clients**: the same protocol over the network, which is also what a hosted control plane would be.
- **Handoffs**: push a half finished branch as a task, or hand off a job from inside a chat session.
- **Agent maintained skills**: when the same correction happens twice, an agent writes a skill into the repo, and prunes skills that stop changing outcomes when models improve.
- **Configurable intent and rigor**, once someone needs it.
- **Teams**: shared through the tracker, PRs and git at first; a possible paid tier later (shared rules, shared runners, collision awareness, decision routing, audit).
- **Business model**: open source everything local; sell a hosted control plane, then a team and governance tier.

## Open questions

- Should triage stay a separate role, or become the builder's first step once models can do both in one run?
- Where are proposed tasks approved: tracker, TUI, or both?
- What does verification evidence look like per project type?
- The plugin interface: process per plugin or in process modules, and how third party plugins are trusted.
- Current plugin surfaces of herdr and other tools need checking before committing.
- The file formats for the brief, summary, report, evidence, findings and proposed tasks (`tasks.md`).
- Resuming a harness session (`claude --resume`) is untested: v3 always started fresh. Does a resumed session keep its permissions and pick up a message typed in straight away?
- Should a change to tests or check config count as critical, so it always needs your approval?
