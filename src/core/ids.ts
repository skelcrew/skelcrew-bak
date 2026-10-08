// Branded IDs. At runtime each is a plain number or string. The brand only
// exists for the typechecker, so a TaskId can't be passed where a SessionId
// is expected. Mixing those up would mean stopping the wrong agent or
// delivering the wrong commit.
//
// Zod adds the brand while it checks an outside value, so no code of ours
// needs an `as` cast. IDs only enter through the boundaries (the CLI,
// plugins, the database), and each boundary parses them with these schemas.

import * as z from "zod";

// Counts up per repository: 1, 2, 3. Shown as "#142". The daemon picks the
// next number. The core never makes one up.
export const TaskId = z.number().int().positive().brand<"TaskId">();
export type TaskId = z.infer<typeof TaskId>;

// Skelcrew's own name for a session, such as "session-k3x9q2mf". The
// daemon makes it up, and the agent's token maps to it.
export const SessionId = z.string().min(1).brand<"SessionId">();
export type SessionId = z.infer<typeof SessionId>;

// Always the full sha, so two commits can never be confused.
export const CommitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .brand<"CommitSha">();
export type CommitSha = z.infer<typeof CommitSha>;
