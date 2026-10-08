# To do

The tasks for the current milestone in `docs/ROADMAP.md`, roughly in order. Tick a task in
the commit that finishes it. When a milestone is done, its tasks go, and the next one is
split into tasks here.

## Open from the core

- [ ] Review the design calls in `docs/core.md`, "Decisions made while building the core".
- [ ] Decide on `AGENTS.md`'s rule that an agent working alone doesn't change the core.
- [ ] Reconcile the spec's "the reducer is a few hundred lines" with `decide.ts` at about
      1,200, by changing the promise or splitting the code.

## Milestone 2: store and loop

- [x] **Event store.** The event log in SQLite. Every event checked by Zod when written and
      when read back, and a damaged row reported with its position.
- [x] **Saved-events fixture.** Real events in today's shape that must always read back, with
      the rule in `AGENTS.md` for when it may be regenerated.
- [ ] **Outbox.** Commands saved with the events that caused them, in one transaction, and
      marked done when their tool finishes.
- [ ] **Loop.** Decide, save, evolve, carry out. A failed save changes nothing. The count of
      starts and stops the tasks no longer record, for the scheduler.
- [ ] **Reopening.** Rebuild every task from the log, resend unfinished commands, and restore
      the count of starts in flight.
- [ ] **Simulator.** The loop with fake tools and scripted agents, so whole lifecycles run in
      tests, including several tasks sharing `max_running`.
- [ ] **Loop property test.** Random inputs through the real loop and store, with failed saves
      and restarts at random moments. Checks rules 10, 16, 17 and 22.
