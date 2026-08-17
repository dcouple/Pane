import { TerminalPanelState } from '../../../../shared/types/panels';

export type CliAgentType = NonNullable<TerminalPanelState['agentType']>;

export const CLI_AGENT_TYPES: readonly CliAgentType[] = ['claude', 'codex', 'cursor'];

const AGENT_EXECUTABLES: Readonly<Record<string, CliAgentType>> = {
  'cursor-agent': 'cursor',
  claude: 'claude',
  codex: 'codex',
};

const SIMPLE_COMMAND_WRAPPERS = new Set(['command', 'exec', 'nohup', 'nice', 'time']);
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_OPTIONS_WITH_SEPARATE_OPERAND = new Set([
  '-u',
  '--unset',
  '-C',
  '--chdir',
  '-P',
]);
const ENV_FLAGS = new Set(['-i', '--ignore-environment', '-0', '--null', '-v', '--debug']);
const MAX_ENV_SPLIT_EXPANSIONS = 16;

function tokenizeShellCommand(command: string, platformHint: NodeJS.Platform): string[] {
  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let windowsPath = false;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (character === '\\' && quote === '"') {
        const nextCharacter = command[index + 1];
        const startsWindowsPath = token === '' ? nextCharacter === '\\' : /^[A-Za-z]:$/.test(token);

        if (platformHint === 'win32' || windowsPath || startsWindowsPath) {
          token += character;
          windowsPath = true;
        } else if (nextCharacter && ['$', '`', '"', '\\', '\n'].includes(nextCharacter)) {
          index += 1;
          if (nextCharacter !== '\n') token += nextCharacter;
        } else {
          token += character;
        }
      } else {
        token += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
    } else if (character === '\\') {
      const nextCharacter = command[index + 1];
      const startsWindowsPath = token === '' ? nextCharacter === '\\' : /^[A-Za-z]:$/.test(token);

      if (platformHint === 'win32' || windowsPath || startsWindowsPath || !nextCharacter) {
        token += character;
        windowsPath = windowsPath || platformHint === 'win32' || startsWindowsPath;
      } else {
        index += 1;
        token += nextCharacter;
      }
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = '';
        tokenStarted = false;
        windowsPath = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (tokenStarted) tokens.push(token);
  return tokens;
}

function expandEnvArguments(
  initialTokens: string[],
  platformHint: NodeJS.Platform,
): string[] | undefined {
  let tokens = initialTokens;
  let splitExpansions = 0;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    if (token === '--') return tokens.slice(index + 1);

    let splitString: string | undefined;
    let consumedTokens = 1;
    if (token === '-S' || token === '--split-string') {
      splitString = tokens[index + 1];
      consumedTokens = 2;
    } else if (token.startsWith('-S') && token.length > 2) {
      splitString = token.slice(2);
    } else if (token.startsWith('--split-string=')) {
      splitString = token.slice('--split-string='.length);
    }

    if (splitString !== undefined) {
      splitExpansions += 1;
      if (splitExpansions > MAX_ENV_SPLIT_EXPANSIONS) return undefined;
      tokens = [
        ...tokens.slice(0, index),
        ...tokenizeShellCommand(splitString, platformHint),
        ...tokens.slice(index + consumedTokens),
      ];
      continue;
    }

    if (ENV_OPTIONS_WITH_SEPARATE_OPERAND.has(token)) {
      index += 2;
      continue;
    }

    if (
      token.startsWith('--unset=') ||
      token.startsWith('--chdir=') ||
      /^-(?:u|C|P).+/.test(token)
    ) {
      index += 1;
      continue;
    }

    if (ENV_FLAGS.has(token)) {
      index += 1;
      continue;
    }

    break;
  }

  return tokens.slice(index);
}

function resolveExecutableToken(command: string, platformHint: NodeJS.Platform): string | undefined {
  let tokens = tokenizeShellCommand(command.trim(), platformHint);
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
      const expandedArguments = expandEnvArguments(tokens.slice(index + 1), platformHint);
      if (!expandedArguments) return undefined;
      tokens = [...tokens.slice(0, index), ...expandedArguments];
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
 * Detect the CLI agent from a POSIX- or Windows-style executable command word,
 * including quoted paths, env options, and supported wrappers. Arguments and
 * directory names are ignored so incidental agent names cannot affect
 * lifecycle handling.
 */
export function resolveAgentTypeFromCommand(
  command?: string,
  platformHint: NodeJS.Platform = process.platform,
): CliAgentType | undefined {
  const executable = command ? resolveExecutableToken(command, platformHint) : undefined;
  const basename = executable?.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
  return basename ? AGENT_EXECUTABLES[basename] : undefined;
}
