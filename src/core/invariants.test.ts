// Property tests: random input sequences, with the rules in
// docs/invariants.md checked after every step. The numbers in the comments
// match the rules there. Only rules tagged (core) are here. The loop's own
// property test checks the rest.
//
// Each step is a choice, not an input. A guided choice picks one of the
// inputs the task accepts right now, so runs get through every phase. An
// unguided one picks any input, so rejections are tested too. Replies and
// agent reports are built from the requests actually sent and the sessions
// actually started, old ones included, so late and repeated replies happen
// all the time.

import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import picomatch from "picomatch";
import { decide } from "./decide";
import { evolve } from "./evolve";
import { CommitSha, SessionId, TaskId } from "./ids";
import { runningSession } from "./task";
import type {
  BranchFacts,
  Command,
  Config,
  Input,
  Role,
  Task,
  TaskEvent,
  TesterCopy,
  Workspace,
} from "./types";

const id = TaskId.parse(142);
const workspace: Workspace = { path: "/repo/.skelcrew/worktrees/142", branch: "skel/142" };
const copyAt = (request: number): TesterCopy => ({
  path: `/repo/.skelcrew/review/142-${request}`,
  commit: sha(request),
});

function sha(n: number): CommitSha {
  return CommitSha.parse(n.toString(16).padStart(40, "0"));
}

const configs = fc.constantFrom<Config>(
  { maxRunning: 2, loopCap: 3, critical: ["src/auth/**"] },
  { maxRunning: 2, loopCap: 1, critical: ["src/auth/**"] },
  { maxRunning: 2, loopCap: 2, critical: [] },
);

// ---------------------------------------------------------------------------
// The world one task lives in
// ---------------------------------------------------------------------------

type Started = { role: Role; edits: boolean };

type World = {
  config: Config;
  task: Task | null;
  log: TaskEvent[];
  sent: Command[]; // every command sent, oldest first
  sessions: Map<SessionId, Started>; // every session started
  // For rule 6 to 8: what passed review and was approved, since the task
  // last left review.
  passed: CommitSha | null;
  approved: CommitSha | null;
  // For rule 14: workspaces and sessions that exist out there, and the stops
  // on their way, with the workspace each removes.
  liveWorkspaces: Set<string>;
  liveSessions: Set<SessionId>;
  stops: Map<number, { session: SessionId; removes: string | null }>;
  lastInput?: Input; // for debugging a failure
};

export function newWorld(config: Config): World {
  return {
    config,
    task: null,
    log: [],
    sent: [],
    sessions: new Map(),
    passed: null,
    approved: null,
    liveWorkspaces: new Set(),
    liveSessions: new Set(),
    stops: new Map(),
  };
}

// Every input worth trying now: from you, the daemon, plugins replying to
// what was sent, and agents in every session started.
function candidates(world: World): Input[] {
  const changes = (files: string[]): BranchFacts => ({ head: sha(900), changedFiles: files });
  const inputs: Input[] = [
    { by: "you", type: "add", title: "Fix export", description: null, plan: null },
    {
      by: "you",
      type: "add",
      title: "Fix export",
      description: null,
      plan: { intent: "ship", rigor: "light", approve: false },
    },
    { by: "you", type: "pause" },
    { by: "you", type: "resume" },
    { by: "you", type: "retry" },
    { by: "you", type: "kill" },
    { by: "you", type: "start_now" },
    { by: "you", type: "set", intent: "answer", rigor: null, approve: null },
    { by: "you", type: "set", intent: "try", rigor: "light", approve: null },
    { by: "you", type: "set", intent: "ship", rigor: "full", approve: null },
    { by: "you", type: "set", intent: null, rigor: null, approve: true },
    { by: "you", type: "set", intent: null, rigor: null, approve: false },
    { by: "you", type: "attach" },
    { by: "you", type: "detach", choice: "resume" },
    { by: "you", type: "detach", choice: "hand_over", branch: changes(["src/auth/login.ts"]) },
    { by: "you", type: "approve" },
    { by: "you", type: "deny", note: "Not like this." },
    { by: "you", type: "reply", text: "Yes" },
    { by: "you", type: "decide_proposals", approved: [0], denied: [] },
    { by: "daemon", type: "start" },
    { by: "daemon", type: "deliver_answer" },
    { by: "plugin", type: "outside_change", what: "issue closed" },
  ];

  for (const command of world.sent) inputs.push(...repliesTo(command));

  for (const [session, started] of world.sessions) {
    inputs.push(
      { by: "agent", session, type: "ask", text: "Which?", options: ["A", "B"] },
      { by: "agent", session, type: "progress", text: "Working." },
      { by: "agent", session, type: "give_up", message: "Stuck." },
      { by: "daemon", type: "usage", session, usage: usageOf(world, session, 100) },
      { by: "daemon", type: "usage", session, usage: usageOf(world, session, -100) },
    );
    if (started.role === "planner") {
      const plan = { rigor: "full" as const, approve: false, brief: "Do it." };
      inputs.push(
        {
          by: "agent",
          session,
          type: "triage_proceed",
          plan: { ...plan, intent: "ship" },
          spec: null,
        },
        {
          by: "agent",
          session,
          type: "triage_proceed",
          plan: { ...plan, intent: "try" },
          spec: "# Spec",
        },
        {
          by: "agent",
          session,
          type: "triage_proceed",
          plan: { ...plan, intent: "answer" },
          spec: null,
        },
        {
          by: "agent",
          session,
          type: "triage_split",
          proposals: [{ title: "Part one", description: "" }],
        },
        { by: "agent", session, type: "triage_decline", reason: "Done already." },
      );
    }
    if (started.role === "builder") {
      inputs.push(
        { by: "agent", session, type: "done", summary: "Done.", branch: changes(["src/a.ts"]) },
        {
          by: "agent",
          session,
          type: "done",
          summary: "Done.",
          branch: changes(["src/auth/x.ts"]),
        },
        { by: "agent", session, type: "done", summary: "Nothing.", branch: changes([]) },
        {
          by: "agent",
          session,
          type: "done_answer",
          report: "Here's why.",
          proposals: [{ title: "Follow up", description: "" }],
          branch: changes([]),
        },
      );
    }
    if (started.role === "tester") {
      inputs.push(
        { by: "agent", session, type: "pass", evidence: "Tests pass." },
        { by: "agent", session, type: "changes", findings: "Fix the header." },
      );
    }
  }
  return inputs;
}

// The replies a plugin could send to a command: success, failure, and for a
// session, its end.
function repliesTo(command: Command): Input[] {
  switch (command.type) {
    case "create_workspace":
      return [
        { by: "plugin", type: "workspace_created", request: command.request, workspace },
        { by: "plugin", type: "workspace_failed", request: command.request, message: "disk" },
      ];
    case "create_copy":
      return [
        {
          by: "plugin",
          type: "copy_created",
          request: command.request,
          copy: { path: copyAt(command.request).path, commit: command.commit },
        },
        { by: "plugin", type: "workspace_failed", request: command.request, message: "disk" },
      ];
    case "start_session": {
      const session = sessionFor(command.request);
      return [
        { by: "plugin", type: "session_started", request: command.request, session },
        { by: "plugin", type: "session_failed", request: command.request, message: "no claude" },
        {
          by: "plugin",
          type: "session_ended",
          request: command.request,
          session,
          exitCode: 1,
          lastLine: "Killed",
        },
      ];
    }
    // A stop reports a save, or a failed one, only when it was asked to save.
    case "stop_session":
      if (command.request === null) return [];
      return (
        command.save
          ? (["saved", "nothing_to_save", "save_failed"] as const)
          : (["nothing_to_save"] as const)
      ).map((saved) => ({
        by: "plugin",
        type: "stopped",
        request: command.request ?? 0,
        session: command.session,
        saved,
        message: "",
      }));
    case "commit_spec":
      return [
        {
          by: "plugin",
          type: "spec_committed",
          request: command.request,
          path: "docs/plans/142.md",
        },
        { by: "plugin", type: "spec_failed", request: command.request, message: "hook" },
      ];
    case "merge_main":
      return [
        {
          by: "plugin",
          type: "main_merged",
          request: command.request,
          reviewed: { head: sha(command.request), changedFiles: ["src/a.ts"] },
        },
        {
          by: "plugin",
          type: "main_merged",
          request: command.request,
          reviewed: { head: sha(command.request), changedFiles: ["src/auth/x.ts"] },
        },
        { by: "plugin", type: "main_conflict", request: command.request, files: ["src/a.ts"] },
        { by: "plugin", type: "main_failed", request: command.request, message: "lock" },
      ];
    case "deliver":
      return [
        {
          by: "plugin",
          type: "delivered",
          request: command.request,
          delivered: { kind: "branch", commit: command.reviewed.head, ref: "skel/142" },
        },
        { by: "plugin", type: "delivery_failed", request: command.request, message: "rejected" },
      ];
    default:
      return [];
  }
}

function sessionFor(request: number): SessionId {
  return SessionId.parse(`session-${request}`);
}

// A usage report `step` tokens above or below the session's last one.
function usageOf(world: World, session: SessionId, step: number) {
  const last = world.task?.usage[session]?.tokens ?? 1_000;
  return { tokens: Math.max(0, last + step), cacheReads: 0, workingMs: 1_000 };
}

// ---------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------

type Choice = { guided: boolean; n: number };

// Inputs that send a task backwards or end it come only from unguided
// choices. Otherwise they crowd out the inputs that move a task on, and few
// runs would reach review and delivery.
const backwards = new Set<string>([
  "kill",
  "pause",
  "set",
  "attach",
  "detach",
  "deny",
  "give_up",
  "outside_change",
  "workspace_failed",
  "session_failed",
  "session_ended",
  "spec_failed",
  "main_failed",
  "delivery_failed",
  "triage_split",
  "triage_decline",
]);

// Inputs that change little. A guided choice takes one only now and then,
// so most guided steps move the task forward.
const small = new Set<string>([
  "progress",
  "usage",
  "ask",
  "reply",
  "deliver_answer",
  "start_now",
  "resume",
  "retry",
  "decide_proposals",
  "changes",
  "main_conflict",
]);

function movesOn(input: Input): boolean {
  if (backwards.has(input.type)) return false;
  return !(input.type === "stopped" && input.saved === "save_failed");
}

export function step(world: World, choice: Choice, at: number): void {
  const all = candidates(world);
  const envelope = (input: Input) => ({ taskId: id, at, input });
  const records = (input: Input) => {
    const decision = decide(world.task, envelope(input), world.config);
    return decision.ok && decision.events.length > 0;
  };
  const accepted = choice.guided ? all.filter((input) => movesOn(input) && records(input)) : all;
  const forward = accepted.filter((input) => !small.has(input.type));
  const pool = choice.guided && forward.length > 0 && choice.n % 4 !== 0 ? forward : accepted;
  const from = pool.length > 0 ? pool : all;
  const input = from[choice.n % from.length];
  if (input === undefined) return;

  const before = world.task;
  const decision = decide(before, envelope(input), world.config);

  // 25 (in AGENTS.md): the same input always gives the same result.
  expect(decide(before, envelope(input), world.config)).toEqual(decision);

  // 4: tasks move only through Skelcrew.
  if (input.type === "outside_change") expect(decision.ok).toBe(false);

  if (!decision.ok) return;
  world.lastInput = input;

  let task = before;
  for (const event of decision.events) {
    const evolved = evolve(task, event);
    if (!evolved.ok) throw new Error(`evolve refused decide's event: ${evolved.reason}`);
    task = evolved.task;
  }
  if (task === null) return;

  checkDecision(world, before, input, decision.events, decision.commands, task);

  world.task = task;
  world.log.push(...decision.events);
  world.sent.push(...decision.commands);
  for (const command of decision.commands) {
    if (command.type === "start_session") {
      world.sessions.set(sessionFor(command.request), { role: command.role, edits: command.edits });
    }
  }
  track(world, decision.events);
  trackResources(world, input, decision.commands);

  checkTask(world, task);
}

// What passed review and what you approved, since the task last left review.
function track(world: World, events: TaskEvent[]): void {
  for (const event of events) {
    if (event.type === "review.passed") world.passed = event.commit;
    if (event.type === "approval.given") world.approved = event.commit;
    if (
      event.type === "review.changes_requested" ||
      event.type === "approval.denied" ||
      event.type === "build.restarted" ||
      event.type === "main.conflict"
    ) {
      world.passed = null;
      world.approved = null;
    }
  }
}

// What exists out there after an accepted input: workspaces and sessions
// come alive with their replies, and go with removals and confirmed stops.
function trackResources(world: World, input: Input, commands: Command[]): void {
  if (input.type === "workspace_created") world.liveWorkspaces.add(input.workspace.path);
  if (input.type === "copy_created") world.liveWorkspaces.add(input.copy.path);
  if (input.type === "session_started") world.liveSessions.add(input.session);
  if (input.type === "session_ended") world.liveSessions.delete(input.session);
  if (input.type === "stopped") {
    const stop = world.stops.get(input.request);
    world.stops.delete(input.request);
    world.liveSessions.delete(input.session);
    if (stop?.removes && input.saved !== "save_failed") world.liveWorkspaces.delete(stop.removes);
  }
  for (const command of commands) {
    if (command.type === "remove_workspace") world.liveWorkspaces.delete(command.path);
    if (command.type === "stop_session") {
      // A cleanup stop is fire and forget. Any other is confirmed later.
      if (command.request === null) world.liveSessions.delete(command.session);
      else {
        world.stops.set(command.request, {
          session: command.session,
          removes: command.remove?.path ?? null,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The rules, checked on each accepted decision
// ---------------------------------------------------------------------------

const yours = new Set([
  "approval.given",
  "approval.denied",
  "proposals.decided",
  "task.set",
  "build.restarted",
  "task.released",
  "task.killed",
  "task.started_now",
  "answer.kept",
  "session.attached",
  "session.detached",
]);

function checkDecision(
  world: World,
  before: Task | null,
  input: Input,
  events: TaskEvent[],
  commands: Command[],
  after: Task,
): void {
  // 1: no agent, plugin or daemon input makes one of your decisions.
  if (input.by !== "you") {
    for (const event of events) expect(yours.has(event.type)).toBe(false);
    if (input.by === "agent" || input.by === "plugin") {
      expect(
        events.some((event) => event.type === "task.held" && event.hold.kind === "paused"),
      ).toBe(false);
    }
  }

  // 2: only the task's current agent is heard.
  if (input.by === "agent" && before !== null) {
    expect(runningSession(before)).toBe(input.session);
  }

  // 3: proposed tasks never enter the queue without you.
  if (input.type !== "decide_proposals") {
    expect(events.some((event) => event.type === "proposals.decided")).toBe(false);
  }

  for (const command of commands) {
    // 9: an answer never gets a session that can edit.
    if (command.type === "start_session" && command.edits) {
      expect(after.phase !== "ended" && after.phase !== "triage" && after.plan.intent).not.toBe(
        "answer",
      );
    }

    // 10: the next agent starts only once the last one's stop is confirmed.
    if (command.type === "start_session") {
      const confirmed = events.some((event) => event.type === "session.stopped");
      expect(before?.stopping === null || confirmed).toBe(true);
    }

    // 15: work that could hold edits is saved when its builder stops.
    if (command.type === "stop_session" && command.request !== null) {
      const started = world.sessions.get(command.session);
      if (started?.role === "builder" && started.edits) expect(command.save).toBe(true);
    }

    // 6 to 9: delivery hands over exactly the reviewed commit, which passed
    // review for `ship`, and was signed off when flagged or critical.
    if (command.type === "deliver") {
      if (after.phase === "ended" || after.phase === "triage")
        throw new Error("deliver from nowhere");
      expect(after.reviewed?.head).toBe(command.reviewed.head);
      expect(command.intent).toBe(after.plan.intent);
      const passed = events.find((event) => event.type === "review.passed");
      const passedCommit = passed?.type === "review.passed" ? passed.commit : world.passed;
      if (after.plan.intent === "ship") expect(passedCommit).toBe(command.reviewed.head);
      const matchers = world.config.critical.map((glob) => picomatch(glob, { dot: true }));
      const critical = command.reviewed.changedFiles.some((file) => matchers.some((m) => m(file)));
      if (after.plan.approve || critical) {
        const given = events.find((event) => event.type === "approval.given");
        const approved = given?.type === "approval.given" ? given.commit : world.approved;
        expect(approved).toBe(command.reviewed.head);
      }
    }

    // 6: the tester's copy is made at the reviewed commit.
    if (command.type === "create_copy" && after.phase === "review") {
      expect(command.commit).toBe(after.reviewed.head);
    }
  }

  // 12, 19: a session that ends without reporting holds the task.
  if (input.type === "session_ended") expect(after.hold?.kind).toBe("crashed");

  // 18: nothing leaves an ending, and an ended task takes only cleanup.
  if (before?.phase === "ended") {
    expect(after.phase).toBe("ended");
    const allowed = new Set([
      "session.stopped",
      "workspace.removed",
      "usage.recorded",
      "proposals.decided",
    ]);
    for (const event of events) expect(allowed.has(event.type)).toBe(true);
  }

  // 21: usage never goes down, per session.
  if (before !== null) {
    for (const [session, last] of Object.entries(before.usage)) {
      const now = after.usage[SessionId.parse(session)];
      expect((now?.tokens ?? 0) >= (last?.tokens ?? 0)).toBe(true);
    }
  }
}

// ---------------------------------------------------------------------------
// The rules, checked on the task after every step
// ---------------------------------------------------------------------------

function checkTask(world: World, task: Task): void {
  // 11: a held task has no agent at work, and none on its way.
  if (task.hold !== null && task.phase !== "ended") {
    expect(runningSession(task)).toBeNull();
    expect(task.step.kind).not.toBe("starting");
  }

  // 13: at most one open question, and 20: only while its agent is the task's.
  if (task.question !== null) {
    expect(runningSession(task)).toBe(task.question.session);
  }
  if (task.keptAnswer !== null) expect(task.question).not.toBeNull();

  // 18: an ended task has no question and isn't attached.
  if (task.phase === "ended") {
    expect(task.question).toBeNull();
    expect(task.attached).toBe(false);
  }

  // Attached only to a working agent.
  if (task.attached) expect(runningSession(task)).not.toBeNull();

  // 14: every live workspace is held by the task, or a stop on its way
  // removes it. Every live session is the task's agent, or being stopped.
  const removing = new Set([...world.stops.values()].map((stop) => stop.removes));
  const stopping = new Set([...world.stops.values()].map((stop) => stop.session));
  for (const path of world.liveWorkspaces) {
    expect(holdsPath(task, path) || removing.has(path)).toBe(true);
  }
  for (const session of world.liveSessions) {
    expect(runningSession(task) === session || stopping.has(session)).toBe(true);
  }

  // 23: replaying the log rebuilds the task exactly.
  let replayed: Task | null = null;
  for (const event of world.log) {
    const evolved = evolve(replayed, event);
    if (!evolved.ok) throw new Error(`replay refused an event: ${evolved.reason}`);
    replayed = evolved.task;
  }
  expect(replayed).toEqual(task);
}

function holdsPath(task: Task, path: string): boolean {
  switch (task.phase) {
    case "ended":
      return task.kept?.path === path;
    case "review":
      return task.workspace.path === path || task.copy?.path === path;
    default:
      return task.workspace?.path === path;
  }
}

// ---------------------------------------------------------------------------
// The properties
// ---------------------------------------------------------------------------

const steps = (minLength: number) =>
  fc.array(fc.record({ guided: fc.boolean(), n: fc.nat(1_000) }), { minLength, maxLength: 150 });

// Runs a lifecycle, guiding a step whenever `guide` says so. The first two
// steps are always guided, so the task exists and starts.
function lifecycle(config: Config, choices: Choice[], guide: (choice: Choice) => boolean): void {
  const world = newWorld(config);
  for (const [i, choice] of choices.entries()) {
    step(world, { ...choice, guided: i < 2 || guide(choice) }, 1_000 + i);
  }
}

describe("the core's invariants", () => {
  test("hold through random lifecycles, half of their steps guided", () => {
    fc.assert(
      fc.property(configs, steps(1), (config, choices) =>
        lifecycle(config, choices, (choice) => choice.guided),
      ),
      { numRuns: 300 },
    );
  });

  test("hold when most steps move the task on", () => {
    fc.assert(
      fc.property(configs, steps(20), (config, choices) =>
        lifecycle(config, choices, (choice) => choice.n % 5 !== 0),
      ),
      { numRuns: 300 },
    );
  });

  test("hold through long lifecycles that reach review, sign-off and delivery", () => {
    fc.assert(
      fc.property(configs, steps(40), (config, choices) =>
        lifecycle(config, choices, (choice) => choice.n % 25 !== 0),
      ),
      { numRuns: 300 },
    );
  });
});
