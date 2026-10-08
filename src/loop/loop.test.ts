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
  test("stamps it with the loop's own clock", () => {
    const store = EventStore.open(":memory:");
    const loop = new Loop(config, recording(), store, { now: () => 5_000 });

    loop.send(id, add());

    const loaded = store.loadTaskEvents(id);
    expect(loaded.ok && loaded.events.map((event) => event.at)).toEqual([5_000]);
  });

  test("saves its events and commands, applies them, then hands the commands out", () => {
    const store = EventStore.open(":memory:");
    const tools = recording();
    const loop = new Loop(config, tools, store);

    loop.send(id, add());
    const decision = loop.send(id, start);

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

    expect(loop.send(id, start).ok).toBe(false);
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

    const decision = loop.send(id, add());

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
    loop.send(id, add());
    loop.send(id, start);

    tools.replies.get(`${id}:create_workspace`)?.(workspaceCreated(1));
    expect(loop.task(id)?.phase === "triage" && loop.task(id)?.requests).toBe(2);
    expect(outboxTypes(store)).toEqual(["start_session"]);
  });

  test("whose save fails is kept by the loop, and saved when it retries", () => {
    const store = EventStore.open(":memory:");
    let failing = false;
    const log: Log = {
      append: (events, commands, answered) =>
        failing ? { ok: false, reason: "disk full" } : store.append(events, commands, answered),
      carriedOut: (commandId) => store.carriedOut(commandId),
    };
    const tools = replying();
    const loop = new Loop(config, tools, log);
    loop.send(id, add());
    loop.send(id, start);
    const reply = tools.replies.get(`${id}:create_workspace`);

    failing = true;
    reply?.(workspaceCreated(1));
    loop.retryReplies();
    expect(outboxTypes(store)).toEqual(["create_workspace"]);

    // The tool never replies again. The loop saves the reply it kept.
    failing = false;
    loop.retryReplies();
    expect(outboxTypes(store)).toEqual(["start_session"]);
    expect(loop.task(id)?.phase === "triage" && loop.task(id)?.requests).toBe(2);
  });

  test("that comes too late still lets its command go", () => {
    const store = EventStore.open(":memory:");
    const tools = replying();
    const loop = new Loop(config, tools, store);
    loop.send(id, add());
    loop.send(id, start);
    loop.send(id, kill);

    tools.replies.get(`${id}:create_workspace`)?.(workspaceCreated(1));
    expect(outboxTypes(store)).toEqual(["remove_workspace"]);
  });
});

describe("a tool's reply that doesn't fit its command", () => {
  // A loop whose task 142 waits for its workspace, with that command's reply.
  function waitingForWorkspace() {
    const store = EventStore.open(":memory:");
    const tools = replying();
    const loop = new Loop(config, tools, store);
    loop.send(id, add());
    loop.send(id, start);
    const reply = tools.replies.get(`${id}:create_workspace`);
    if (reply === undefined) throw new Error("No workspace was asked for.");
    return { store, loop, reply };
  }

  test("of another kind is a bug in the tool, and saves nothing", () => {
    const { store, reply } = waitingForWorkspace();

    expect(() => reply(sessionStarted(1, planner))).toThrow(
      "The reply to create_workspace was session_started, which doesn't answer it.",
    );
    expect(outboxTypes(store)).toEqual(["create_workspace"]);
  });

  test("for another request is a bug in the tool", () => {
    const { reply } = waitingForWorkspace();

    expect(() => reply(workspaceCreated(7))).toThrow(
      "The reply to create_workspace was for request 7, and the command is request 1.",
    );
  });

  test("of null, for a command that has a reply, is a bug in the tool", () => {
    const { reply } = waitingForWorkspace();

    expect(() => reply(null)).toThrow(
      "The reply to create_workspace was null, which doesn't answer it.",
    );
  });

  test("from anyone but a tool is a bug in the tool", () => {
    const { reply } = waitingForWorkspace();

    expect(() => reply({ by: "you", type: "approve" })).toThrow(
      "The reply to create_workspace was approve, which doesn't answer it.",
    );
  });
});

describe("starting what waits", () => {
  // Three tasks, added one after another.
  function threeQueued(tools: Tools) {
    const loop = new Loop(config, tools, EventStore.open(":memory:"));
    for (const n of [1, 2, 3]) loop.send(TaskId.parse(n), add());
    return loop;
  }

  test("starts the oldest queued tasks, up to max_running", () => {
    const loop = threeQueued(recording());

    expect(loop.startWaiting()).toEqual([TaskId.parse(1), TaskId.parse(2)]);
    expect(loop.startWaiting()).toEqual([]);
  });

  test("keeps the slot of a start sent for a task that was killed, until its tool replies", () => {
    const tools = replying();
    const loop = threeQueued(tools);
    loop.startWaiting();
    loop.send(TaskId.parse(1), kill);

    expect(loop.inFlight).toBe(1);
    expect(loop.startWaiting()).toEqual([]);

    tools.replies.get("1:create_workspace")?.(workspaceCreated(1));
    expect(loop.inFlight).toBe(0);
    expect(loop.startWaiting()).toEqual([TaskId.parse(3)]);
  });
});

describe("reopening after a restart", () => {
  test("rebuilds every task, and sends unfinished commands again", () => {
    const store = EventStore.open(":memory:");
    const before = new Loop(config, { carryOut: () => {} }, store);
    before.send(id, add());
    before.send(id, start);

    const tools = recording();
    const opened = Loop.open(config, tools, store);

    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.loop.task(id)).toEqual(before.task(id));
    expect(tools.handed).toEqual([{ type: "create_workspace", taskId: id, request: 1 }]);
  });

  test("forgets a resent command once its tool replies", () => {
    const store = EventStore.open(":memory:");
    const before = new Loop(config, { carryOut: () => {} }, store);
    before.send(id, add());
    before.send(id, start);

    const tools = replying();
    Loop.open(config, tools, store);
    tools.replies.get(`${id}:create_workspace`)?.(workspaceCreated(1));
    expect(outboxTypes(store)).toEqual(["start_session"]);
  });

  test("still counts the slot of a start sent for a task killed before the restart", () => {
    const store = EventStore.open(":memory:");
    const before = new Loop(config, { carryOut: () => {} }, store);
    before.send(id, add());
    before.send(id, start);
    before.send(id, kill);

    const opened = Loop.open(config, { carryOut: () => {} }, store);
    expect(opened.ok && opened.loop.inFlight).toBe(1);
  });

  test("refuses to open a damaged log, saying where", () => {
    const damaged: ReadableLog = {
      append: () => ({ ok: true, ids: [] }),
      carriedOut: () => ({ ok: true }),
      loadTasks: () => ({ ok: false, row: 7, reason: "not JSON" }),
      loadCommands: () => ({ ok: true, commands: [] }),
    };
    const opened = Loop.open(config, recording(), damaged);

    expect(opened).toEqual({ ok: false, reason: "Event 7: not JSON" });
  });

  test("refuses to open a damaged outbox, saying which command", () => {
    const damaged: ReadableLog = {
      append: () => ({ ok: true, ids: [] }),
      carriedOut: () => ({ ok: true }),
      loadTasks: () => ({ ok: true, tasks: new Map() }),
      loadCommands: () => ({ ok: false, row: 3, reason: "no type" }),
    };

    expect(Loop.open(config, recording(), damaged)).toEqual({
      ok: false,
      reason: "Command 3: no type",
    });
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
      loop.send(id, input);
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
    reopened.loop.send(id, { by: "daemon", type: "deliver_answer" });

    expect(outboxWhileTyping).toEqual([0]);
  });
});

describe("a tool replying from inside carryOut", () => {
  test("is caught, so one input is handled at a time", () => {
    const tools: Tools = { carryOut: (_command, reply) => void reply(workspaceCreated(1)) };
    const loop = new Loop(config, tools, EventStore.open(":memory:"));
    loop.send(id, add());

    expect(() => loop.send(id, start)).toThrow(
      "A tool replied from inside carryOut. Reply later instead.",
    );
  });
});

describe("typing, when the outbox can't let it go", () => {
  test("doesn't type, so a restart can't type it a second time", () => {
    const store = EventStore.open(":memory:");
    const loop = new Loop(config, { carryOut: () => {} }, store);
    for (const input of [add(), start, workspaceCreated(1), sessionStarted(2, planner)]) {
      loop.send(id, input);
    }
    loop.send(id, ask(planner));
    loop.send(id, reply("Yes"));

    const typed: string[] = [];
    const stuck: Log = {
      append: (events, commands, answered) => store.append(events, commands, answered),
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
    reopened.loop.send(id, { by: "daemon", type: "deliver_answer" });

    expect(typed).toEqual([]);
  });
});
