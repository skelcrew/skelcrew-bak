# Core model

**Status: approved.** This is the core from `docs/spec.md`, worked out in enough detail to
write tests against. It holds no code. The rules it must never break are in
`docs/invariants.md`.

## A task

A task is always in one **phase**: triage, build, review, or ended. Each phase carries only
the data it needs, and has its own small **step** machine. A step that waits on a reply holds
its request number.

On top of the phase, a task can have:

- **an open question**: an agent asked, and waits for your answer
- **a hold**: its agent is stopped, and it won't start again until you act. The hold says
  why: you paused it, the agent crashed or gave up, the loop cap was reached, or a command
  failed. Skelcrew never retries on its own.
- **you attached**: you are in its session

None of these changes the phase. When the question is answered or the hold is lifted, the
task carries on in the same phase and step.

**Waiting on you** is a view, not a state: a task with an open question, one awaiting
approval, or one held for any reason but a pause.

### What each phase holds

| Phase | Holds |
|---|---|
| triage | the workspace and the planner's session, once they exist |
| build | intent, rigor, approval flag, brief, spec path, the workspace, the builder's session, the loop count, and what was handed over |
| review | everything build holds, plus the reviewed commit, the task's changed files, the tester's copy and session, and the evidence once review passes |
| ended | the outcome (done, split, declined, killed, failed), what was handed over, any proposals with your decisions on them, and a workspace whose work couldn't be saved |

Every task also holds its ID, source and source ID, title, request counter and usage.

### One workspace per task

The task's workspace is created when triage starts, as a worktree on a new branch from main,
such as `skel/142-empty-export`. If triage is skipped, it is created at the start of build
instead. The planner works in it read only. If it writes a spec, Skelcrew commits the spec to
the branch as `docs/plans/142-empty-export.md`. The builder then works in the same worktree.

A split or a decline removes the workspace and the branch.

### The tester's copy

The tester gets a separate detached copy at the reviewed commit. It is writable, since
`setup` and the tests write files such as installed packages and caches. It is never
committed, nothing in it flows back, and it is thrown away after the verdict.

### Where agents write files

No role may write anywhere outside its permissions. So the planner and tester, which have no
edit permission on the task's code, need somewhere to put a brief, findings or evidence
before passing them to a `skel` command. Each session may write to `.skelcrew/out/` in its
workspace, which git ignores. The daemon reads the file when the command arrives, and stores
its text in the event.

## Steps

### Triage

1. **queued**: waits for a slot.
2. **creating workspace** (request): the worktree and branch are being made.
3. **starting** (request): the planner's session is starting.
4. **running** (session): the planner works.
5. **committing spec** (request): only when the planner proceeds with a spec. Skelcrew commits
   it to the branch, since the planner has no edit permission.

Triage ends with one of:

- **proceed**: the planner is stopped. Once the stop is confirmed, the task moves to build,
  keeping its slot.
- **split**: the planner is stopped, and the proposals wait for you. The task ends as split,
  and its workspace and branch are removed.
- **decline**: the planner is stopped. The task ends as declined, with the reason. Its
  workspace and branch are removed.

The planner can also **ask**. That doesn't end triage.

### Build

1. **queued**: waits for a slot. A task gets here when triage was skipped, after a hold is
   lifted, or after a change of intent.
2. **creating workspace** (request): only when triage was skipped.
3. **starting** (request): the builder's session is starting.
4. **running** (session): the builder works.
5. **handed over**: the builder ran `skel done`. The daemon attaches what the branch holds:
   its head commit, and every file the branch changed since it left main. The builder never
   supplies these. The builder is stopped. If review asks for changes, a fresh builder
   starts with the findings.
6. **merging main** (request): only for `ship` and `try`. The reply is one of:
   - **merged**: with the resulting commit and the task's changed files. That commit is the
     **reviewed commit**.
   - **conflict**: the merge is left unfinished, and the builder gets it back. That counts as
     a loop.
   - **failed**: git failed for another reason, such as a lock. The task is held.

For `answer`, which merges nothing, the reviewed commit is the handed-over one.

When triage was skipped, the brief is the task's title and description.

After build:

- `ship` and `answer` move to review, keeping the task's slot.
- `try` skips review. It goes to approval if it needs it, otherwise to delivery.

### Review

1. **creating workspace** (request): the tester's copy at the reviewed commit.
2. **starting** (request): the tester's session is starting.
3. **running** (session): the tester works.

The verdict:

- **pass**: the tester is stopped and its copy removed. Then approval if the task needs it,
  otherwise delivery.
- **changes**: the tester is stopped and its copy removed. The loop count goes up. Under the
  cap, the task is back in build, and a fresh builder starts with the findings once the
  tester's stop is confirmed. At the cap, the task is held with the findings.

### Approval and delivery

These are the last steps of whichever phase ran last: review, or build for `try`.

- **awaiting approval**: reached when the task has the approval flag, or when its changed
  files touch a file matching `critical` in config. The core checks the changed files
  itself, so a planner that judged wrong can't skip it. No agent runs, so no slot is held.
  `skel approve` moves on to delivery. `skel deny 142 "why"` sends the task back to build
  with your note. A denial doesn't count as a loop, since it isn't a failure.
- **delivering** (request): the output plugin hands over exactly the reviewed commit, as a
  branch, a PR or a report. Anything committed after it stays out. A failed delivery holds
  the task. The task ends as done only when delivery is confirmed.

### Stopping an agent

An agent is stopped whenever it is replaced, let go, paused, held or killed. A stop always
goes in this order:

1. The session is stopped.
2. If its workspace can hold edits, any uncommitted work is committed.
3. The reply says **stopped**, with one of: saved, nothing to save, or save failed.

The next agent on the task starts only once the stop is confirmed, and the task keeps its
slot until then. If the save failed, the task is held with "its work couldn't be saved", and
its workspace is never removed.

### Handover

`skel done` answers at once, and the builder is stopped. The task keeps its slot for the
tester. If review asks for changes, a fresh builder starts with the findings. Claude Code
moves a shell command to the background after 2 minutes, so a `done` that waited for the
verdict would quietly stop waiting.

### Questions

- **Asking.** The agent runs `skel ask` and ends its turn. The question opens, and the task
  gives up its slot.
- **Answering.** Your answer is kept until a slot is free, then typed into the session.
- **Losing the agent.** If the session ends, the question goes with it. A fresh session may
  ask again.

### Changing intent, rigor or approval

`skel set` overrules the planner's call. It is never refused for timing: while a workspace
or session is starting, or main is merging, it waits until the step settles, then applies.

- **Approval applies at once.** Setting it stops a task before delivery. Clearing it on a
  task awaiting approval sends it on to delivery, unless its changed files still touch a
  critical path.
- **Rigor applies from the next phase.** A running build or review carries on. The next
  review uses the new depth. A change to `full` mid-build adds no spec.
- **Intent restarts build.** The builder is stopped and a fresh session starts, on the same
  branch and in the same workspace, since the permissions change. Commits already on the
  branch stay, and the loop count is kept. After a change to `answer`, the code stays on the
  branch, and only the report is handed over.
- **During triage, intent and rigor together end triage**, as `skel add --ship --light`
  skips it. The planner is stopped and build starts. Either one alone wins over what the
  planner proposes for that field.

## Slots

- **A task keeps its slot across phase changes.** It gives the slot up only when it waits on
  you, is held, or ends. So work already under way finishes before new work starts.
- **An attached task keeps its slot**, since its agent keeps working with you.
- **Starts and stops in flight hold a slot**, as the spec says.
- **The scheduler's order:** answers to questions, then resumed tasks, then queued tasks.
  Oldest first within each.
- **You can go past `max_running`.** `skel start 145` starts at once, even when every slot
  is taken. The limit binds only what Skelcrew starts on its own.

## Inputs

Inputs are typed by sender. The boundary that receives a call sets the sender, never the
caller.

### From you

| Input | Does |
|---|---|
| add | a new task. Intent and rigor given together skip triage. |
| set | changes intent, rigor or approval. Each takes effect in its own way, see Changing intent, rigor or approval. |
| reply | answers the open question. Waits for a slot before it reaches the agent. |
| approve / deny | signs off a task, or sends it back to build with a note |
| approve proposals / deny proposals | on tasks proposed by a split or an answer, after the task has ended |
| attach / detach | steps into the session, and back out with resume or hand over |
| pause / resume | holds the task, or lifts your pause |
| start | starts the task now, even past `max_running` |
| retry | lifts a hold, whatever its reason |
| kill | ends the task |

A reply on the tracker, through an input plugin, counts as yours only when it comes from an
account configured as yours. That is the one plugin input that carries one of your
decisions.

### From agents

Each agent input names its session. Only the session the task's step holds is heard, and only
for its own role.

| Role | Inputs |
|---|---|
| planner | triage proceed, triage split, triage decline, ask, give up |
| builder | ask, progress, done (summary, or report and proposed tasks for `answer`), give up |
| tester | pass with evidence, changes with findings, ask, give up |

### From plugins

- **Task sources:** a task arrived.
- **Outside changes:** an issue closed, reopened or relabelled in the tracker. Always
  refused. Tasks move only through Skelcrew.
- **Replies to commands**, listed with each command below. A reply for a request the task no
  longer waits on is late. It is accepted with only the commands that clean up after it,
  such as stopping a session that started late, and changes nothing else.

### From the daemon

- **start**: the scheduler picked the task for a free slot.
- **deliver answer**: the scheduler found a slot for a kept answer.
- **usage**: each session's running totals, read from its transcript. The task's usage is
  the sum. It is shown, never enforced.

How long an agent has been quiet is read from its transcript and shown on the screen. It is
not an input, since nothing in the core acts on it.

## Commands

Each command that expects a reply carries the task's next request number. Every command with
a reply has a success reply and a failure reply.

| Command | Replies |
|---|---|
| create workspace (the task's, or the tester's copy at a commit) | created, failed |
| remove workspace | none |
| start session (role, workspace, brief, findings or answer to pass on) | started, failed, and later ended |
| stop session (save work or not) | stopped: saved, nothing to save, or save failed |
| commit spec | committed with its path, failed |
| type into session | none |
| merge main | merged with the commit and changed files, conflict, failed |
| deliver output (the reviewed commit, the summary or report, and the evidence) | delivered, failed |

**No retries.** A failure reply holds the task with what happened. You retry it with
`skel retry`.

**Repeats after a crash.** The outbox may send a command twice, and each tool treats a repeat
as doing nothing. Typing into a session is the exception. It is recorded as sent before it
is typed, so a crash in between loses the message rather than typing it twice. A lost
message shows as an idle agent, and you can reply again.

Output plugins that only mirror state, such as an issue comment or a notification, listen to
events. They never block a task, and the core sends them no command.

## Decisions made while building the core

**Status: waiting for your review.** Building the core unattended forced these calls, which
the sections above don't make. The code and its tests follow them.

**Waiting instead of refusing**

- **Pause, set and start wait while a step is under way**: a workspace or copy being made, a
  session starting, a spec being committed, main merging, or a delivery. They also wait
  while an agent is still stopping. The core refuses with "waits until it settles", and the
  CLI sends the input again. Kill always works.
- **Approval set during a delivery is too late for it.** A delivery under way finishes.
  Setting approval on a task whose delivery failed makes it wait for your sign-off first.
- **Approving, or clearing approval, waits until a held task is resumed.**
- **A start carries on from where the task waits.** A build that was handed over merges or
  goes to review instead of building again. A review whose tester crashed, gave up or was
  paused reuses its copy, which stays until the task leaves review.
- **Resuming puts a task at the front of the line once.** Once it starts, it waits in line
  like any other task.
- **`skel set` with nothing to change is refused.**

**Holds and failures**

- **A hold only sends a step with an agent back to the queue.** A merge, a spec commit, an
  approval or a delivery keeps its step, so an approval still waits for you.
- **A failure answers its request.** After a failed merge, spec commit or delivery, nothing
  waits for a reply. Your retry puts the task back in line, and the scheduler's next start
  sends the step again, so a retry never goes past `max_running`.
- **What comes back must match what was asked.** A tester's copy of any other commit than
  the reviewed one is removed, and holds the task. So does a delivery of another commit, or
  of the wrong kind: a branch for an `answer`, or a report for anything else.
- **A failed save on a task already held keeps the existing hold.** `session.stopped`
  records the failed save, and the work stays in the workspace.
- **A workspace holding unsaved work is never removed**, not even by kill, until a later
  save succeeds. The task records it.
- **A stop takes the question of the agent it stops**, so no question outlives its agent.
- **A stop's reply must name the session being stopped**, or it changes nothing. A reply
  saying a save failed, for a stop that didn't save, means there was nothing to save.

**Workspaces and stops**

- **A stop says what it removes once the work is safe.** It removes nothing if the save
  failed. A split or decline deletes the branch too, since nothing was built. A kill keeps
  the branch, since it holds the work. Delivery removes the worktree and keeps the branch.
- **An ended task keeps track of its workspace** until its removal is confirmed. It accepts
  only a stop's confirmation, a workspace removal, usage, and your decisions on proposals.
- **Late replies change nothing.** Any reply to a request the task no longer waits on is
  accepted and records nothing. A workspace or copy that arrives late is removed, and a
  session that starts late is stopped. That stop has no request, since nobody waits on it.
  A repeated reply for what the task already holds, or is stopping, is ignored.
- **An ended task keeps what was handed over** and the tester's evidence, for the record.
- **The scheduler skips a task while its last agent is stopping**, and that task keeps its
  slot until the stop is confirmed, even once held or ended.
- **Merging main and committing a spec hold a slot; delivery doesn't.** No agent runs in
  any of them, but the next agent starts straight after a merge or a spec commit, without
  asking the scheduler again. Holding the slot is what keeps that within `max_running`.
  Nothing starts after a delivery. A review suggested dropping the slot for all three, to
  remove the "a failure answers its request" machinery. That would let a retried merge
  start a tester past `max_running`, so it wasn't taken.
- **Killing a task while a session is starting keeps its workspace**, and the late
  session's stop saves any work it did. Every late session's stop saves.

**Events**

- **`build.restarted`** carries the new plan when you change intent, or when your intent and
  rigor end triage. It says whether the build waits for an agent's stop first.
- **`review.ready`** moves an `answer` to review with its handed-over commit, since it merges
  nothing.
- **A spec is committed while the planner stops.** The builder starts once both are done,
  in either order.
- **Detaching to hand over** needs the branch facts from the daemon, as `done` does, and only
  a builder's work can be handed over.
- **Usage is kept per session.** A report lower than that session's last one is older, and
  is refused.
