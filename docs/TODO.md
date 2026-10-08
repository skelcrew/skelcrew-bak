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

## Milestone 2: store and loop

- [x] **Event store.** The event log in SQLite. Every event checked by Zod when written and
      when read back, and a damaged row reported with its position.
- [x] **Saved-events fixture.** Real events in today's shape that must always read back, with
      the rule in `AGENTS.md` for when it may be regenerated.
- [x] **Outbox.** Commands saved with the events that caused them, in one transaction, and
      marked done when their tool finishes.
- [x] **Loop.** Decide, save, evolve, carry out. A failed save changes nothing. The count of
      starts and stops the tasks no longer record, for the scheduler.
- [x] **Reopening.** Rebuild every task from the log, resend unfinished commands, and restore
      the count of starts in flight.
- [x] **Simulator.** The loop with fake tools and scripted agents, so whole lifecycles run in
      tests, including several tasks sharing `max_running`.
- [x] **Loop property test.** Random inputs through the real loop and store, with failed saves
      and restarts at random moments. Checks rules 10, 16, 17 and 22.
