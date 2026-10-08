import { describe, expect, test } from "bun:test";
import { TaskId } from "../core/ids";
import {
  add,
  ask,
  config,
  id,
  kill,
  planner,
  reply,
  sessionStarted,
  start,
  workspaceCreated,
} from "../core/testing";
import type { Command } from "../core/types";
import { EventStore } from "../store/store";
import { type Log, Loop, type ReadableLog, type Reply, type Tools } from "./loop";

// Tools that only remember what they were handed.
function recording(): Tools & { handed: Command[] } {
  const handed: Command[] = [];
  return { handed, carryOut: (command) => handed.push(command) };
}

describe("sending an input", () => {
  test("saves its events and commands, applies them, then hands the commands out", () => {
    const store = EventStore.open(":memory:");
    const tools = recording();
    const loop = new Loop(config, tools, store);

    loop.send(id, add(), 1_000);
    const decision = loop.send(id, start, 2_000);

    expect(decision.ok).toBe(true);
    const task = loop.task(id);
    expect(task?.phase === "triage" && task.step).toEqual({
      kind: "creating_workspace",
      request: 1,
    });
    expect(tools.handed).toEqual([{ type: "create_workspace", taskId: id, request: 1 }]);
    const saved = store.loadTasks();
    if (!saved.ok || task === null) throw new Error("nothing saved");
    expect(saved.tasks.get(id)).toEqual(task);
    expect(store.loadCommands()).toEqual({
      ok: true,
      commands: [{ id: 1, command: { type: "create_workspace", taskId: id, request: 1 } }],
    });
  });

  test("that is rejected changes nothing", () => {
    const tools = recording();
    const loop = new Loop(config, tools, EventStore.open(":memory:"));

    expect(loop.send(id, start, 1_000).ok).toBe(false);
    expect(loop.task(id)).toBeNull();
    expect(tools.handed).toEqual([]);
  });

  test("whose save fails changes nothing, and sends nothing", () => {
    const failing: Log = {
      append: () => ({ ok: false, reason: "disk full" }),
      carriedOut: () => ({ ok: true }),
    };
    const tools = recording();
    const loop = new Loop(config, tools, failing);

    const decision = loop.send(id, add(), 1_000);

    expect(decision).toEqual({
      ok: false,
      rejection: { input: "add", reason: "The events couldn't be saved: disk full" },
    });
    expect(loop.task(id)).toBeNull();
    expect(tools.handed).toEqual([]);
  });
});

// Tools that keep each command's reply function, to reply when a test says.
function replying(): Tools & { replies: Map<string, Reply> } {
  const replies = new Map<string, Reply>();
  return {
    replies,
    carryOut: (command, reply) => {
      const task = "taskId" in command ? command.taskId : 0;
      replies.set(`${task}:${command.type}`, reply);
    },
  };
}

function outboxTypes(store: EventStore): string[] {
  const saved = store.loadCommands();
  if (!saved.ok) throw new Error(saved.reason);
  return saved.commands.map(({ command }) => command.type);
}

describe("a tool's reply", () => {
  test("is saved together with its command leaving the outbox", () => {
    const store = EventStore.open(":memory:");
    const tools = replying();
    const loop = new Loop(config, tools, store);
    loop.send(id, add(), 1_000);
    loop.send(id, start, 2_000);

    expect(tools.replies.get(`${id}:create_workspace`)?.(workspaceCreated(1))).toBe(true);
    expect(loop.task(id)?.phase === "triage" && loop.task(id)?.requests).toBe(2);
    expect(outboxTypes(store)).toEqual(["start_session"]);
  });

  test("whose save fails keeps its command in the outbox, and says so", () => {
    const store = EventStore.open(":memory:");
    let failing = false;
    const log: Log = {
      append: (events, commands, done) =>
        failing ? { ok: false, reason: "disk full" } : store.append(events, commands, done),
      carriedOut: (commandId) => store.carriedOut(commandId),
    };
    const tools = replying();
    const loop = new Loop(config, tools, log);
    loop.send(id, add(), 1_000);
    loop.send(id, start, 2_000);
    const reply = tools.replies.get(`${id}:create_workspace`);

    failing = true;
    expect(reply?.(workspaceCreated(1))).toBe(false);
    expect(outboxTypes(store)).toEqual(["create_workspace"]);

    failing = false;
    expect(reply?.(workspaceCreated(1))).toBe(true);
    expect(outboxTypes(store)).toEqual(["start_session"]);
  });

  test("that comes too late still lets its command go", () => {
    const store = EventStore.open(":memory:");
    const tools = replying();
    const loop = new Loop(config, tools, store);
    loop.send(id, add(), 1_000);
    loop.send(id, start, 2_000);
    loop.send(id, kill, 3_000);

    expect(tools.replies.get(`${id}:create_workspace`)?.(workspaceCreated(1))).toBe(true);
    expect(outboxTypes(store)).toEqual(["remove_workspace"]);
  });
});

describe("starting what waits", () => {
  // Three tasks, added one after another.
  function threeQueued(tools: Tools) {
    const loop = new Loop(config, tools, EventStore.open(":memory:"));
    for (const n of [1, 2, 3]) loop.send(TaskId.parse(n), add(), n);
    return loop;
  }

  test("starts the oldest queued tasks, up to max_running", () => {
    const loop = threeQueued(recording());

    expect(loop.startWaiting(10)).toEqual([TaskId.parse(1), TaskId.parse(2)]);
    expect(loop.startWaiting(11)).toEqual([]);
  });

  test("keeps the slot of a start sent for a task that was killed, until its tool replies", () => {
    const tools = replying();
    const loop = threeQueued(tools);
    loop.startWaiting(10);
    loop.send(TaskId.parse(1), kill, 11);

    expect(loop.inFlight).toBe(1);
    expect(loop.startWaiting(12)).toEqual([]);

    tools.replies.get("1:create_workspace")?.(workspaceCreated(1));
    expect(loop.inFlight).toBe(0);
    expect(loop.startWaiting(13)).toEqual([TaskId.parse(3)]);
  });
});

describe("reopening after a restart", () => {
  test("rebuilds every task, and sends unfinished commands again", () => {
    const store = EventStore.open(":memory:");
    const before = new Loop(config, { carryOut: () => {} }, store);
    before.send(id, add(), 1_000);
    before.send(id, start, 2_000);

    const tools = recording();
    const opened = Loop.open(config, tools, store);

    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.loop.task(id)).toEqual(before.task(id));
    expect(tools.handed).toEqual([{ type: "create_workspace", taskId: id, request: 1 }]);
  });

  test("forgets a resent command once its tool replies", () => {
    const store = EventStore.open(":memory:");
    const before = new Loop(config, { carryOut: () => {} }, store);
    before.send(id, add(), 1_000);
    before.send(id, start, 2_000);

    const tools = replying();
    Loop.open(config, tools, store);
    tools.replies.get(`${id}:create_workspace`)?.(workspaceCreated(1));
    expect(outboxTypes(store)).toEqual(["start_session"]);
  });

  test("still counts the slot of a start sent for a task killed before the restart", () => {
    const store = EventStore.open(":memory:");
    const before = new Loop(config, { carryOut: () => {} }, store);
    before.send(id, add(), 1_000);
    before.send(id, start, 2_000);
    before.send(id, kill, 3_000);

    const opened = Loop.open(config, { carryOut: () => {} }, store);
    expect(opened.ok && opened.loop.inFlight).toBe(1);
  });

  test("refuses to open a damaged log, saying where", () => {
    const damaged: ReadableLog = {
      append: () => ({ ok: true, ids: [] }),
      carriedOut: () => ({ ok: true }),
      loadTasks: () => ({ ok: false, seq: 7, reason: "not JSON" }),
      loadCommands: () => ({ ok: true, commands: [] }),
    };
    const opened = Loop.open(config, recording(), damaged);

    expect(opened).toEqual({ ok: false, reason: "Event 7: not JSON" });
  });
});

describe("typing into a session", () => {
  test("is marked carried out before it is typed, so a crash never types it twice", () => {
    const store = EventStore.open(":memory:");
    const loop = new Loop(config, { carryOut: () => {} }, store);
    for (const input of [
      add(),
      start,
      workspaceCreated(1),
      sessionStarted(2, planner),
      ask(planner),
      reply("Yes"),
    ]) {
      loop.send(id, input, 1_000);
    }

    // How many typing commands the outbox still held while each was typed.
    const outboxWhileTyping: number[] = [];
    const typing: Tools = {
      carryOut: (command) => {
        if (command.type !== "type_into_session") return;
        const saved = store.loadCommands();
        if (!saved.ok) throw new Error(saved.reason);
        const left = saved.commands.filter((c) => c.command.type === "type_into_session");
        outboxWhileTyping.push(left.length);
      },
    };
    const reopened = Loop.open(config, typing, store);
    if (!reopened.ok) throw new Error(reopened.reason);
    reopened.loop.send(id, { by: "daemon", type: "deliver_answer" }, 2_000);

    expect(outboxWhileTyping).toEqual([0]);
  });
});

describe("a tool replying from inside carryOut", () => {
  test("is caught, so one input is handled at a time", () => {
    const tools: Tools = { carryOut: (_command, reply) => void reply(workspaceCreated(1)) };
    const loop = new Loop(config, tools, EventStore.open(":memory:"));
    loop.send(id, add(), 1_000);

    expect(() => loop.send(id, start, 2_000)).toThrow(
      "A tool replied from inside carryOut. Reply later instead.",
    );
  });
});

describe("typing, when the outbox can't let it go", () => {
  test("doesn't type, so a restart can't type it a second time", () => {
    const store = EventStore.open(":memory:");
    const loop = new Loop(config, { carryOut: () => {} }, store);
    for (const input of [add(), start, workspaceCreated(1), sessionStarted(2, planner)]) {
      loop.send(id, input, 1_000);
    }
    loop.send(id, ask(planner), 1_000);
    loop.send(id, reply("Yes"), 1_000);

    const typed: string[] = [];
    const stuck: Log = {
      append: (events, commands, done) => store.append(events, commands, done),
      carriedOut: () => ({ ok: false, reason: "disk full" }),
    };
    const tools: Tools = {
      carryOut: (command) => {
        if (command.type === "type_into_session") typed.push(command.text);
      },
    };
    const reopened = Loop.open(config, tools, {
      ...stuck,
      loadTasks: () => store.loadTasks(),
      loadCommands: () => store.loadCommands(),
    });
    if (!reopened.ok) throw new Error(reopened.reason);
    reopened.loop.send(id, { by: "daemon", type: "deliver_answer" }, 2_000);

    expect(typed).toEqual([]);
  });
});
