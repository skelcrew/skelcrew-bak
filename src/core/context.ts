// What decide's steps share: the context every step gets, and a few small
// helpers for building decisions.

import type {
  Command,
  Config,
  Decision,
  Envelope,
  EventBody,
  Hold,
  Task,
  Timestamp,
} from "./types";

// What every step needs besides the task and the input.
export type Context = {
  accept: (bodies: EventBody[], commands?: Command[]) => Decision;
  reject: (reason: string) => Decision;
  at: Timestamp;
  config: Config;
};

export function makeContext({ taskId, at, input }: Envelope, config: Config): Context {
  return {
    accept: (bodies, commands = []) => ({
      ok: true,
      events: bodies.map((body) => ({ ...body, v: 1, taskId, at })),
      commands,
    }),
    reject: (reason) => ({ ok: false, rejection: { input: input.type, reason } }),
    at,
    config,
  };
}

export function held(hold: Hold): EventBody {
  return { type: "task.held", hold };
}

// The number for the task's next request. The event that records a request
// and the command that sends it both use it. An input that sends two takes
// this one and the one after.
export function next(task: Task): number {
  return task.requests + 1;
}

// Why a reply is refused: it answers a request the task isn't waiting on.
export function notWaitingFor(task: Task, request: number): string {
  return `This reply answers request ${request}, but #${task.id} isn't waiting on it.`;
}

export function isBlank(text: string): boolean {
  return text.trim() === "";
}
