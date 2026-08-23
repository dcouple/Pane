/**
 * Parent-agent session markers that must never reach a spawned agent.
 *
 * When Pane is launched from inside a Claude Code session — a terminal, a
 * script, a dev run — it inherits that session's identity. Claude Code sees
 * `CLAUDE_CODE_CHILD_SESSION` in a child process and turns transcript
 * persistence off ("Transcript saving is off — inherited
 * CLAUDE_CODE_CHILD_SESSION marker"). Nothing is written, so a later
 * `claude --resume <id>` fails with "No conversation found with session ID"
 * and the pane comes back empty after a restart.
 *
 * Every terminal Pane spawns is a *new* top-level session, so the launching
 * agent's markers are always wrong to pass along.
 *
 * Kept in its own module so it can be unit-tested without dragging in the
 * database singleton that `terminalPanelManager` depends on.
 */
const INHERITED_AGENT_SESSION_VARS = new Set([
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
]);

/** Copy an environment, dropping the launching agent's session identity. */
export function stripInheritedAgentSession(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !INHERITED_AGENT_SESSION_VARS.has(entry[0])
    )
  );
}
