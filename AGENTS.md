# skelcrew

Skelcrew runs coding agents in parallel, always on and unattended. You make decisions; you
don't supervise. The design is in `docs/spec.md`. Read it before changing anything it
covers. What earlier versions taught us is in `docs/learnings.md`.

## Hard constraints

These are correctness requirements, not preferences. A change that breaks one is wrong even
if a task asks for it. Stop and report the conflict instead.

- **The human merges.** Every change stops at a pull request.
- **Never force push. Never skip a check, and never use `--no-verify`.**
- **Never weaken a test, fixture or assertion to get green.** If a test cannot pass
  honestly, stop and say why.
- **The spec is never edited to match the code.** If the code and `docs/spec.md` disagree,
  stop and report it. The human decides which one changes.

## Critical code

The core decides what agents may do, so it gets the closest care. The critical code is the
reducer (`decide` and `evolve`), the scheduler, their types, and the invariants.

- The types, events and invariants come first, and the human approves them. The code is
  written against them.
- Tests come before code, and the human reads them closely. A wrong test here is more
  dangerous than wrong code.
- One transition at a time. The human reads every diff before it lands.
- An agent working alone does not change the core. Work there happens in a live session
  with the human.

## Code rules

- **The core has no side effects.** It never reads the clock, files or the network, and
  never makes up IDs. Time and IDs arrive as inputs, and side effects leave as commands.
  The same inputs must always give the same result.
- **Every event carries its task and its moment.** Its task ID and time are the ones on the
  input that caused it.
- **Strict TypeScript.** No `any`, no `!` to silence a possible null, no `as` casts. The
  tsconfig has `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` on.
- **Check every outside input** with Zod: plugin input, CLI requests, config and replies
  from outside services.
- **Errors are values in the core.** Functions return a result that says what failed. They
  do not throw.

## Test first

Every change to behaviour starts with a failing test.

- **Red, then green.** Write the failing test first. Run it, and confirm it fails for the
  reason you meant: an import or fixture error is a broken test, not red. Then write the
  smallest code that passes, and tidy up while the test stays green.
- **Never add a test after the code.** A test written against existing code checks what the
  code does, not what it should do.
- **Tests check what a user of the code sees**, never private helpers. Tests never start a
  real agent or call an outside service. The simulator stands in for them.

## Definition of done

```
bun run check
```

It runs the lint and format check, the typecheck, and the tests. It never changes files.
`bun run fix` does that.

The tests run through a watchdog that stops a run hung for more than 6
minutes. Bun's test runner can hang past every timer inside the run, so only a separate
process can stop it.

- **Commit in small, self-contained slices.** Each commit passes `bun run check` on its own,
  and its message says what changed and why. A failing test and its fix land in the same
  commit. Two small diffs review better than one large one, so split before the first
  review.

## Writing for the human

Everything the human reads must make sense on the first read. That covers commit messages,
pull requests, review notes, spec changes and chat. A text that needs deciphering has
failed, however accurate it is.

- **The plain answer first.** One sentence that says what happened or what is needed. Then
  the detail, if any.
- **One idea per sentence**, about 20 words at most. No stacked clauses, no semicolons
  joining two ideas, no em-dashes.
- **The reader's words, not the code's.** Say what a person sees or does. Use a name from
  the code only when the reader needs it to find something, and explain it in the same
  sentence.
- **An example when the mechanism is hard to picture.** A small concrete case beats a
  description of how the parts connect.
- **Say the consequence.** "An agent could approve its own work" beats a description of
  which check is missing.
- **No invented terms.** Define a new word in plain words the first time, or don't use it.

Before sending, read the text as someone who was not there. If a sentence needs a second
read, rewrite it.

## Evidence

- **Run it, don't remember it.** Before writing that something works, exists or is
  impossible, run the command or read the line.
- **A claimed limitation needs proof:** the exact error, or the command that showed it.
- **An honest partial result beats a made-up complete one.** If you skipped a step, say
  which. A clean report of work that did not happen is the worst thing you can produce.

## Layout

- `docs/spec.md`: the design. The source of truth for what Skelcrew does.
- `docs/ROADMAP.md`: the milestones, in order.
- `docs/TODO.md`: the tasks for the current milestone. A new milestone is split into tasks here when it starts, and a task is ticked in the commit that finishes it.
- `docs/core.md`: the core worked out in words: phases, steps, inputs by sender, commands.
- `docs/invariants.md`: the rules the core must never break. Tests are written against it.
- `docs/learnings.md`: what v3 taught us, and code worth reusing from it.
- `docs/ARCHITECTURE.md`: a short guide to reading the code: the main parts, how an input
  flows through them, and where to start.
- `src/core/`: the core. Critical code, see above.
- `src/checks/run-tests.ts`: the test watchdog.
- `CLAUDE.md` links to this file, so every agent reads the same rules.

The saved events fixture joins this list when the store exists, see Saved events below.

**Keep `docs/ARCHITECTURE.md` short.** It is an overview, not a catalogue. It names the main
parts and how they fit, never single files, functions or features, so most changes leave it
alone. Update it only when a main part is added, removed or renamed, or when the way an input
flows through the parts changes. If it grows past a few screens, it is describing too much.
v3's grew to a table row per file and changed in almost every pull request.

## Saved events

The event log is kept forever, so every event shape that was ever saved must still read
back. A fixture file of saved events guards this, and a test reads it on every run.

- **Until dogfooding starts**, an event's shape may change. The fixture is then regenerated
  in the same commit, and the commit message says so.
- **Once dogfooding starts**, the fixture is never regenerated. A change to an event's shape
  then needs a way to read the old shape, and a new version number on the event.
