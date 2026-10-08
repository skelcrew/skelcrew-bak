# Core invariants

**Status: approved.** These are the rules the core must never break, whatever
happens. You approve every change to this list. Property tests send thousands of random
input sequences, and check every rule after every step. Each transition's tests are written
against this list.

A rule belongs here if breaking it would let an agent do something only you may do, lose
work, run more agents than allowed, or leave you looking at a wrong picture. The rules are
about what Skelcrew does. Anyone with access to the repository can still act outside it, for
example by merging a branch by hand.

The terms come from `docs/core.md`.

## The six promises

1. **Only you decide.** No agent or tool makes one of your calls, and only a task's current
   agent is heard.
2. **Nothing ships unchecked.** What Skelcrew hands over is exactly the commit that passed
   review, and flagged or critical work waits for your sign-off.
3. **Agents stay within limits.** Skelcrew never puts more than `max_running` to work on its
   own, and a held task stays stopped until you act.
4. **Nothing is lost.** Work is saved before an agent is let go, and every workspace, session
   and command is accounted for.
5. **What you see is true.** Endings are final, crashes are noticed, and usage only grows.
6. **The log replays exactly.** Replaying the saved events rebuilds the same tasks.

The numbered rules below are the testable detail of each promise. Each is tagged with the
property test that owns it:

- **core**: random inputs sent straight to `decide` and `evolve`, one task or several sharing
  the scheduler.
- **loop**: random inputs through the real loop and store, with failed saves and restarts at
  random moments.

## 1. Only you decide

1. **Agents never take your decisions.** The planner's triage call and the scheduler's start
   are proposals the rules allow. Everything else that changes a task's course is yours: an
   override with `skel set`, an approval, an answer, a decision on proposals, and starting
   now, pausing, resuming, retrying or killing. No agent, plugin or daemon input ever makes
   one. One exception: a reply on the tracker counts as your answer, but only from an
   account configured as yours. _(core)_
2. **Only the task's current agent is heard.** An agent input is accepted only from the
   session the task's step holds, and only if its role fits the phase. A builder can't pass
   its own review. _(core)_
3. **Proposed tasks never enter the queue without you.** A task proposed by a split or an
   answer becomes a task only after `proposals.approved`. _(core)_
4. **Outside changes are requests.** An issue closed, reopened or relabelled in the tracker
   never moves or ends a task. _(core)_
5. **A rejected input changes nothing.** It produces no events and no commands. A late reply
   isn't rejected: it is accepted with only the commands that clean up after it, and changes
   no state. _(core)_

## 2. Nothing ships unchecked

6. **One reviewed commit.** Review, approval and delivery all use the same commit: the
   handed-over work with main merged in. Nothing committed after it is handed over. _(core)_
7. **`ship` never ends as done without `review.passed`** on the reviewed commit. _(core)_
8. **Sign-off before done.** A task never ends as done without `approval.given`, given after
   its last `review.passed`, or after its last `build.done` for `try`, when either:
   - it has the approval flag, or
   - its changes touch a file matching `critical` in config. The changes are everything the
     branch changed since it left main, not only its last commit. _(core)_
9. **Intent sets hard limits.** Skelcrew never hands over a `try` as mergeable, and never
   starts a session with edit permissions on an `answer` task. _(core)_

## 3. Agents stay within limits

10. **Skelcrew never puts more than `max_running` agents to work on its own.** Starts and stops
    in flight count, and so does an attached session, since its agent keeps working with you.
    A task waiting on you or held counts for none. Only your `skel start` can go past the
    limit. A task has at most one agent at work and one slot, and the next
    agent on a task starts only after the last one's stop is confirmed. _(core, loop)_
11. **A held task has no agent at work, and never starts again without you.** _(core)_
12. **Every failure holds the task.** A crash, a failed command and the loop cap each hold the
    task with what happened. Nothing is retried on its own, and nothing is passed silently.
    _(core)_
13. **At most one open question per task.** _(core)_

## 4. Nothing is lost

14. **No workspace or session is left untracked.** Every one the core asked for is either
    held on its task or has been sent a command to remove or stop it. _(core)_
15. **Work is saved before it is let go.** The agent is stopped first, then any uncommitted
    work is committed. If that commit fails, the task is held and its workspace is never
    removed. The tester's copy holds nothing to save, and is thrown away. _(core)_
16. **Every saved command is carried out once the daemon runs.** A repeat after a crash has
    the effect of once. The one exception is typing into a session, which happens at most
    once. A lost message shows as an idle agent. _(loop)_
17. **A failed save changes nothing.** No state changes, and no command goes out. _(loop)_

## 5. What you see is true

18. **Nothing leaves an ending.** An ended task accepts only the cleanup of a late session or
    workspace, a late usage report, and your decision on its proposals. _(core)_
19. **A session that ends without reporting never goes unnoticed.** It holds the task with its
    exit code and last line. _(core)_
20. **No question outlives its agent.** A question exists only while the session that asked it
    is the task's agent. _(core)_
21. **Usage never goes down.** Each session's totals only grow, and a task's usage is the sum
    of its sessions. A report lower than that session's last is older, and is refused.
    _(core)_

## 6. The log replays exactly

22. **Replaying the log rebuilds every task exactly.** Folding a task's events through
    `evolve` from nothing gives the task the core had before. After a restart, the loop's
    tasks match a fresh replay of the saved log. _(core, loop)_

Two rules about how the core is written, rather than what happens to a task, live in
`AGENTS.md` under Code rules: the same input always gives the same result, and every event
carries its task and its moment.
