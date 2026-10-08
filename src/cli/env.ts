// The environment a daemon started by skel gets: yours, without any
// session's. A command run from an agent's shell must not hand that agent's
// token, or its harness's own variables, to every session the daemon starts
// later. The spec says Claude Code's child session variables are removed, or
// it writes no transcript.
export function daemonEnv(env: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const sessions = name.startsWith("SKELCREW_") || name.startsWith("CLAUDE");
    if (value !== undefined && !sessions) kept[name] = value;
  }
  return kept;
}
