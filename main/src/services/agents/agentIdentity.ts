import { TerminalPanelState } from '../../../../shared/types/panels';

export type CliAgentType = NonNullable<TerminalPanelState['agentType']>;

export const CLI_AGENT_TYPES: readonly CliAgentType[] = ['claude', 'codex', 'cursor'];

const AGENT_EXECUTABLES: Readonly<Record<string, CliAgentType>> = {
  'cursor-agent': 'cursor',
  claude: 'claude',
  codex: 'codex',
};

const SIMPLE_COMMAND_WRAPPERS = new Set(['command', 'exec', 'nohup']);
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"$` ])/g, '$1'));
  }
  return tokens;
}

function resolveExecutableToken(command: string): string | undefined {
  const tokens = tokenizeShellCommand(command.trim());
  let index = 0;

  while (ENVIRONMENT_ASSIGNMENT.test(tokens[index] ?? '')) index += 1;
  while (SIMPLE_COMMAND_WRAPPERS.has((tokens[index] ?? '').toLowerCase())) index += 1;

  if ((tokens[index] ?? '').toLowerCase() === 'env') {
    index += 1;
    while ((tokens[index] ?? '').startsWith('-') || ENVIRONMENT_ASSIGNMENT.test(tokens[index] ?? '')) index += 1;
  }

  return tokens[index];
}

export function isCliAgentType(value: unknown): value is CliAgentType {
  return typeof value === 'string' && (CLI_AGENT_TYPES as readonly string[]).includes(value);
}

/**
 * Detect the CLI agent from the executable command word, including quoted
 * paths and simple wrappers. Arguments and directory names are deliberately
 * ignored so incidental agent names cannot affect lifecycle handling.
 */
export function resolveAgentTypeFromCommand(command?: string): CliAgentType | undefined {
  const executable = command ? resolveExecutableToken(command) : undefined;
  const basename = executable?.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
  return basename ? AGENT_EXECUTABLES[basename] : undefined;
}
