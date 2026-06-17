import {
  RUNPANE_CONTRACT,
  type ArtifactFormat,
  type InstallTarget,
  type RunpaneChannel,
  type RunpaneCommand
} from './generated/contract';

export type { ArtifactFormat, InstallTarget, RunpaneCommand };

export interface ParsedArgs {
  command: RunpaneCommand;
  helpTopic?: string;
  target: InstallTarget;
  paneVersion: string;
  channel: RunpaneChannel;
  format: ArtifactFormat;
  downloadDir?: string;
  panePath?: string;
  dryRun: boolean;
  yes: boolean;
  verbose: boolean;
  remoteSetupArgs: string[];
}

const COMMANDS = new Set<string>(RUNPANE_CONTRACT.commands.map((command) => command.name));
const TARGETS = new Set<string>(RUNPANE_CONTRACT.enums.installTargets);
const FORMATS = new Set<string>(RUNPANE_CONTRACT.enums.artifactFormats);
const CHANNELS = new Set<string>(RUNPANE_CONTRACT.enums.channels);

const REMOTE_VALUE_FLAGS = new Set<string>(RUNPANE_CONTRACT.flags.remoteValue.map((flag) => flag.name));
const REMOTE_BOOLEAN_FLAGS = new Set<string>(RUNPANE_CONTRACT.flags.remoteBoolean.map((flag) => flag.name));

const DEFAULTS: Omit<ParsedArgs, 'command'> = {
  target: RUNPANE_CONTRACT.defaults.target,
  paneVersion: RUNPANE_CONTRACT.defaults.paneVersion,
  channel: RUNPANE_CONTRACT.defaults.channel,
  format: RUNPANE_CONTRACT.defaults.format,
  dryRun: RUNPANE_CONTRACT.defaults.dryRun,
  yes: RUNPANE_CONTRACT.defaults.yes,
  verbose: RUNPANE_CONTRACT.defaults.verbose,
  remoteSetupArgs: []
};

export function parseRunpaneArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const first = args.shift();

  if (!first || first === '-h' || first === '--help') {
    return { command: 'help', ...DEFAULTS };
  }

  if (first === '-v' || first === '--version') {
    return { command: 'version', ...DEFAULTS };
  }

  if (!COMMANDS.has(first)) {
    throw new Error(`Unknown command: ${first}\n\n${helpText()}`);
  }

  if (first === 'help') {
    return {
      command: 'help',
      helpTopic: args[0],
      ...DEFAULTS
    };
  }

  const parsed: ParsedArgs = {
    command: first as RunpaneCommand,
    ...DEFAULTS,
    remoteSetupArgs: []
  };

  if (parsed.command === 'install' && args[0] && !args[0].startsWith('-')) {
    const target = args.shift();
    if (!target || !TARGETS.has(target)) {
      throw new Error(`Unknown install target: ${target ?? ''}. Expected "client" or "daemon".`);
    }
    parsed.target = target as InstallTarget;
  }

  if (parsed.command === 'update') {
    parsed.target = 'client';
  }

  parseFlags(args, parsed);
  return parsed;
}

function parseFlags(args: string[], parsed: ParsedArgs): void {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === '-h' || arg === '--help') {
      const topic = parsed.command;
      parsed.command = 'help';
      parsed.helpTopic = topic;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      parsed.yes = true;
      continue;
    }
    if (arg === '--verbose') {
      parsed.verbose = true;
      continue;
    }
    if (arg === '--version') {
      parsed.paneVersion = readValue(args, ++index, arg);
      continue;
    }
    if (arg === '--download-dir') {
      parsed.downloadDir = readValue(args, ++index, arg);
      continue;
    }
    if (arg === '--pane-path') {
      parsed.panePath = readValue(args, ++index, arg);
      continue;
    }
    if (arg === '--format') {
      const value = readValue(args, ++index, arg);
      if (!FORMATS.has(value)) {
        throw new Error(`Invalid --format "${value}". Expected one of: ${[...FORMATS].join(', ')}`);
      }
      parsed.format = value as ArtifactFormat;
      continue;
    }

    if (REMOTE_VALUE_FLAGS.has(arg)) {
      const value = readValue(args, ++index, arg);
      if (arg === '--channel') {
        if (!CHANNELS.has(value)) {
          throw new Error(`Invalid --channel "${value}". Expected stable or nightly.`);
        }
        parsed.channel = value as RunpaneChannel;
      }
      appendRemoteArg(parsed, arg, value);
      continue;
    }

    if (REMOTE_BOOLEAN_FLAGS.has(arg)) {
      appendRemoteArg(parsed, arg);
      continue;
    }

    if (parsed.command === 'install' && parsed.target === 'daemon') {
      index = appendUnknownRemoteArg(args, index, parsed, arg);
      continue;
    }

    throw new Error(`Unknown option for ${parsed.command}: ${arg}`);
  }
}

function appendRemoteArg(parsed: ParsedArgs, flag: string, value?: string): void {
  if (parsed.command === 'install' && parsed.target === 'daemon') {
    parsed.remoteSetupArgs.push(flag);
    if (value !== undefined) {
      parsed.remoteSetupArgs.push(value);
    }
    return;
  }

  if (REMOTE_VALUE_FLAGS.has(flag) || REMOTE_BOOLEAN_FLAGS.has(flag)) {
    throw new Error(`${flag} is only valid with "runpane install daemon".`);
  }
}

function appendUnknownRemoteArg(args: string[], index: number, parsed: ParsedArgs, arg: string): number {
  parsed.remoteSetupArgs.push(arg);
  const next = args[index + 1];
  if (arg.startsWith('-') && next && !next.startsWith('-')) {
    parsed.remoteSetupArgs.push(next);
    return index + 1;
  }
  return index;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function helpText(topic?: string): string {
  const helpTopics = RUNPANE_CONTRACT.help.npm;
  const key = topic && Object.prototype.hasOwnProperty.call(helpTopics, topic)
    ? topic as keyof typeof helpTopics
    : 'default';
  return helpTopics[key].join('\n');
}
