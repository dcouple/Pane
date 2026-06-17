export type RunpaneCommand = 'help' | 'install' | 'update' | 'version' | 'doctor';
export type InstallTarget = 'client' | 'daemon';
export type ArtifactFormat = 'auto' | 'appimage' | 'deb' | 'dmg' | 'zip' | 'exe';

export interface ParsedArgs {
  command: RunpaneCommand;
  helpTopic?: string;
  target: InstallTarget;
  paneVersion: string;
  channel: 'stable' | 'nightly';
  format: ArtifactFormat;
  downloadDir?: string;
  panePath?: string;
  dryRun: boolean;
  yes: boolean;
  verbose: boolean;
  remoteSetupArgs: string[];
}

const COMMANDS = new Set(['help', 'install', 'update', 'version', 'doctor']);
const TARGETS = new Set(['client', 'daemon']);
const FORMATS = new Set(['auto', 'appimage', 'deb', 'dmg', 'zip', 'exe']);
const CHANNELS = new Set(['stable', 'nightly']);

const REMOTE_VALUE_FLAGS = new Set([
  '--label',
  '--prefer-tunnel',
  '--channel',
  '--base-url',
  '--pane-dir',
  '--listen-port',
  '--port',
  '--repo-ref'
]);

const REMOTE_BOOLEAN_FLAGS = new Set([
  '--auto-listen-port',
  '--interactive-tailscale-setup',
  '--no-install-service',
  '--no-tailscale-serve',
  '--print-only'
]);

const DEFAULTS: Omit<ParsedArgs, 'command'> = {
  target: 'client',
  paneVersion: 'latest',
  channel: 'stable',
  format: 'auto',
  dryRun: false,
  yes: false,
  verbose: false,
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
        parsed.channel = value as 'stable' | 'nightly';
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
  if (topic === 'install') {
    return [
      'Usage:',
      '  runpane install [client|daemon] [options]',
      '',
      'Examples:',
      '  npx --yes runpane@latest install client',
      '  npx --yes runpane@latest install daemon --label "My Server"',
      '  pnpm dlx runpane@latest install daemon --prefer-tunnel ssh --label "VM"',
      '',
      'Wrapper options:',
      '  --version <latest|vX.Y.Z>        Pane release to install',
      '  --format <auto|appimage|deb|dmg|zip|exe>',
      '  --download-dir <path>',
      '  --pane-path <path>               Use an existing Pane executable',
      '  --dry-run                       Print the plan without downloading',
      '  --yes                           Skip interactive prompts where possible',
      '  --verbose',
      '',
      'Daemon passthrough options:',
      '  --label <name>',
      '  --prefer-tunnel <tailscale|ssh|manual|auto>',
      '  --channel <stable|nightly>',
      '  --base-url <url>',
      '  --pane-dir <path>',
      '  --listen-port <port> / --port <port>',
      '  --auto-listen-port',
      '  --interactive-tailscale-setup',
      '  --no-install-service',
      '  --no-tailscale-serve',
      '  --print-only',
      '  --repo-ref <ref>'
    ].join('\n');
  }

  if (topic === 'update') {
    return [
      'Usage:',
      '  runpane update [options]',
      '',
      'Updates Pane using the same artifact selection as "runpane install client".',
      '',
      'Options:',
      '  --version <latest|vX.Y.Z>',
      '  --format <auto|appimage|deb|dmg|zip|exe>',
      '  --download-dir <path>',
      '  --pane-path <path>',
      '  --dry-run',
      '  --yes',
      '  --verbose'
    ].join('\n');
  }

  if (topic === 'version') {
    return 'Usage:\n  runpane version\n  runpane --version';
  }

  if (topic === 'doctor') {
    return 'Usage:\n  runpane doctor [--pane-path <path>] [--format <format>] [--verbose]';
  }

  return [
    'Usage:',
    '  runpane install [client|daemon] [options]',
    '  runpane update [options]',
    '  runpane version',
    '  runpane doctor',
    '  runpane help [command]',
    '',
    'Package manager examples:',
    '  npx --yes runpane@latest install daemon --label "My Server"',
    '  pnpm dlx runpane@latest install daemon --label "My Server"',
    '  npm i -g runpane && runpane install daemon --label "My Server"',
    '',
    'Python package equivalents:',
    '  pipx run runpane install daemon --label "My Server"',
    '  uvx runpane@latest install daemon --label "My Server"',
    '',
    'Run "runpane help install" for install options.'
  ].join('\n');
}
