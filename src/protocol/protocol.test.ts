import { describe, expect, test } from "bun:test";
import { TaskId } from "../core/ids";
import {
  type Answer,
  encode,
  MAX_LINE,
  parseAnswer,
  parseRequest,
  type Request,
  VERSION,
} from "./protocol";

const add: Request = {
  v: VERSION,
  id: "1",
  token: null,
  call: {
    type: "send",
    task: null,
    input: { type: "add", title: "Fix the export", description: null, plan: null },
  },
};

const done: Request = {
  v: VERSION,
  id: "2",
  token: "secret-token",
  call: { type: "send", task: null, input: { type: "done", summary: "Fixed it." } },
};

describe("a request", () => {
  test("reads back as it was sent", () => {
    for (const request of [add, done, { ...add, call: { type: "ls" as const } }]) {
      expect(parseRequest(encode(request).trimEnd())).toEqual({ ok: true, value: request });
    }
  });

  test("is one line, ending in a newline", () => {
    const line = encode(add);

    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd()).not.toContain("\n");
  });

  test("that isn't JSON is refused", () => {
    expect(parseRequest("{not json")).toEqual({
      ok: false,
      message: "The request isn't valid JSON.",
    });
  });

  test("with a field the protocol doesn't have is refused, saying where", () => {
    const line = JSON.stringify({ ...add, call: { ...add.call, urgent: true } });
    const parsed = parseRequest(line);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toContain("call");
    expect(!parsed.ok && parsed.message).toContain("urgent");
  });

  test("from another version of the protocol is refused, saying what to do", () => {
    const parsed = parseRequest(JSON.stringify({ ...add, v: VERSION + 1 }));

    expect(parsed).toEqual({
      ok: false,
      message: `The daemon speaks protocol ${VERSION}, and this request is ${VERSION + 1}. Restart the daemon with \`skel serve\` after updating.`,
    });
  });

  test("longer than the limit is refused before it is read", () => {
    const parsed = parseRequest("x".repeat(MAX_LINE + 1));

    expect(parsed).toEqual({
      ok: false,
      message: `The request is longer than ${MAX_LINE} bytes.`,
    });
  });
});

describe("an answer", () => {
  test("reads back as it was sent", () => {
    const answers: Answer[] = [
      { v: VERSION, id: "1", ok: true, result: { kind: "sent", task: TaskId.parse(142) } },
      {
        v: VERSION,
        id: "3",
        ok: true,
        result: {
          kind: "tasks",
          tasks: [
            {
              task: TaskId.parse(142),
              title: "Fix the export",
              phase: "build",
              intent: "ship",
              rigor: "light",
              state: "building",
            },
          ],
        },
      },
      { v: VERSION, id: "2", ok: false, message: "#142 has an open question." },
    ];

    for (const answer of answers) {
      expect(parseAnswer(encode(answer).trimEnd())).toEqual({ ok: true, value: answer });
    }
  });
});
