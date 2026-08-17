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
const ENV_OPTIONS_WITH_SEPARATE_OPERAND = new Set([
  '-u',
  '--unset',
  '-C',
  '--chdir',
  '-S',
  '--split-string',
]);

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (character === '\\' && quote === '"' && index + 1 < command.length) {
        index += 1;
        token += command[index];
      } else {
        token += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
    } else if (character === '\\' && index + 1 < command.length) {
      index += 1;
      token += command[index];
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = '';
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (tokenStarted) tokens.push(token);
  return tokens;
}

function skipEnvOptions(tokens: string[], startIndex: number): number {
  let index = startIndex;

  while (index < tokens.length) {
    const token = tokens[index];

    if (token === '--') return index + 1;

    if (ENV_OPTIONS_WITH_SEPARATE_OPERAND.has(token)) {
      index += 2;
      continue;
    }

    if (
      token.startsWith('--unset=') ||
      token.startsWith('--chdir=') ||
      token.startsWith('--split-string=') ||
      /^-(?:u|C|S).+/.test(token)
    ) {
      index += 1;
      continue;
    }

    if (token.startsWith('-')) {
      index += 1;
      continue;
    }

    break;
  }

  return index;
}

function resolveExecutableToken(command: string): string | undefined {
  const tokens = tokenizeShellCommand(command.trim());
  let index = 0;

  while (index < tokens.length) {
    if (ENVIRONMENT_ASSIGNMENT.test(tokens[index])) {
      index += 1;
      continue;
    }

    if (SIMPLE_COMMAND_WRAPPERS.has(tokens[index].toLowerCase())) {
      index += 1;
      continue;
    }

    if (tokens[index].toLowerCase() === 'env') {
      index = skipEnvOptions(tokens, index + 1);
      continue;
    }

    break;
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
