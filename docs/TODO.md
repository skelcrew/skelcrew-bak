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
