import { TerminalPanelState } from '../../../../shared/types/panels';

export type CliAgentType = NonNullable<TerminalPanelState['agentType']>;

export const CLI_AGENT_TYPES: readonly CliAgentType[] = ['claude', 'codex', 'cursor'];

const AGENT_COMMAND_PATTERNS: ReadonlyArray<{ agent: CliAgentType; pattern: RegExp }> = [
  { agent: 'cursor', pattern: /(^|[\s/])cursor-agent($|\s)/ },
  { agent: 'claude', pattern: /(^|[\s/])claude($|\s)/ },
  { agent: 'codex', pattern: /(^|[\s/])codex($|\s)/ },
];

export function isCliAgentType(value: unknown): value is CliAgentType {
  return typeof value === 'string' && (CLI_AGENT_TYPES as readonly string[]).includes(value);
}

/**
 * Detect the CLI agent from a launch command. Matches the binary as a
 * standalone token (start/space/slash-delimited), not a substring — a command
 * whose cwd or script path merely contains the word (e.g. /tmp/claude-501/x.sh)
 * must not be classified as that agent.
 */
export function resolveAgentTypeFromCommand(command?: string): CliAgentType | undefined {
  const lower = command?.toLowerCase() ?? '';
  return AGENT_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(lower))?.agent;
}
