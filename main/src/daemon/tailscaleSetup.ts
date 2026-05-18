import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface ResolvedCommand {
  command: string;
  displayCommand: string;
  env?: NodeJS.ProcessEnv;
}

interface InstallAttempt {
  attempted: boolean;
  command: string;
  stdout: string;
  stderr: string;
  reason?: string;
}

export function buildTailscaleServeCommand(command: ResolvedCommand | null, port: number): string {
  return `${command?.displayCommand ?? 'tailscale'} serve --bg http://127.0.0.1:${port}`;
}

export function installTailscaleCommandOrThrow(): ResolvedCommand {
  const installAttempt = installTailscaleForPlatform();
  const resolvedCommand = resolveTailscaleCommand();
  if (resolvedCommand) {
    return resolvedCommand;
  }

  throw new Error(buildTailscaleInstallError(installAttempt));
}

export function resolveTailscaleCommand(): ResolvedCommand | null {
  if (commandExistsWithArgs('tailscale', ['version'])) {
    return {
      command: 'tailscale',
      displayCommand: 'tailscale',
    };
  }

  if (process.platform === 'darwin') {
    const macAppCommand = resolveMacTailscaleAppCommand();
    if (macAppCommand) {
      return macAppCommand;
    }
  }

  if (process.platform === 'win32') {
    const windowsCommand = resolveWindowsTailscaleCommand();
    if (windowsCommand) {
      return windowsCommand;
    }
  }

  return null;
}

export function ensureTailscaleInstalled(): ResolvedCommand {
  return resolveTailscaleCommand() ?? installTailscaleCommandOrThrow();
}

export function ensureTailscaleInstalledInteractive(): ResolvedCommand {
  const existingCommand = resolveTailscaleCommand();
  if (existingCommand) {
    return existingCommand;
  }

  const installAttempt = installTailscaleForPlatform({ interactive: true });
  const resolvedCommand = resolveTailscaleCommand();
  if (resolvedCommand) {
    return resolvedCommand;
  }

  throw new Error(buildTailscaleInstallError(installAttempt));
}

export function runTailscaleUpInteractive(command: ResolvedCommand): void {
  const isLinux = process.platform === 'linux';
  const executable = isLinux ? 'sudo' : command.command;
  const args = isLinux ? [command.command, 'up'] : ['up'];
  const result = spawnSync(executable, args, {
    stdio: 'inherit',
    env: command.env ?? process.env,
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    throw new Error(`Tailscale authentication stopped with signal ${result.signal}`);
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`Tailscale authentication exited with code ${result.status}`);
  }
}

export function runCommand(
  command: string | ResolvedCommand,
  args: string[],
  options: { timeoutMs?: number } = {},
): CommandResult {
  const resolved = typeof command === 'string'
    ? { command, env: process.env }
    : { command: command.command, env: command.env ?? process.env };
  const result = spawnSync(resolved.command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30000,
    env: resolved.env,
  } satisfies SpawnSyncOptionsWithStringEncoding);

  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
}

export function runCommandInteractive(
  command: string | ResolvedCommand,
  args: string[],
  options: { timeoutMs?: number } = {},
): CommandResult {
  const resolved = typeof command === 'string'
    ? { command, env: process.env }
    : { command: command.command, env: command.env ?? process.env };
  const result = spawnSync(resolved.command, args, {
    stdio: 'inherit',
    timeout: options.timeoutMs ?? 30000,
    env: resolved.env,
  });

  return {
    ok: !result.error && result.status === 0,
    stdout: '',
    stderr: result.error ? result.error.message : '',
  };
}

export function runShellCommand(command: string, options: { timeoutMs?: number } = {}): CommandResult {
  const result = spawnSync(command, {
    encoding: 'utf8',
    shell: true,
    timeout: options.timeoutMs ?? 30000,
  });

  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
}

export function runShellCommandInteractive(command: string, options: { timeoutMs?: number } = {}): CommandResult {
  const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    timeout: options.timeoutMs ?? 30000,
  });

  return {
    ok: !result.error && result.status === 0,
    stdout: '',
    stderr: result.error ? result.error.message : '',
  };
}

export function getTailscaleSetupInstructions(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Pane installs Tailscale on macOS with "brew install --cask tailscale" when Homebrew is available. Open Tailscale, sign in, then run setup again.';
    case 'win32':
      return 'Pane installs Tailscale on Windows with "winget install --id Tailscale.Tailscale --exact". Open Tailscale, sign in, then run setup again.';
    case 'linux':
      if (isWsl()) {
        return 'Pane installs Tailscale inside WSL with the official install script when curl is available. Run "sudo tailscale up" in the distro, then run setup again.';
      }
      return 'Pane installs Tailscale on Linux with "curl -fsSL https://tailscale.com/install.sh | sh" when curl is available. Run "sudo tailscale up", then run setup again.';
    default:
      return 'Install Tailscale from https://tailscale.com/download, sign in, then run setup again.';
  }
}

function resolveMacTailscaleAppCommand(): ResolvedCommand | null {
  const candidates = [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    path.join(os.homedir(), 'Applications', 'Tailscale.app', 'Contents', 'MacOS', 'Tailscale'),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    const command = {
      command: candidate,
      displayCommand: `TAILSCALE_BE_CLI=1 ${quoteForPosix(candidate)}`,
      env: {
        ...process.env,
        TAILSCALE_BE_CLI: '1',
      },
    };
    if (commandExistsWithArgs(command, ['version'])) {
      return command;
    }
  }

  return null;
}

function resolveWindowsTailscaleCommand(): ResolvedCommand | null {
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Tailscale', 'tailscale.exe') : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Tailscale', 'tailscale.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Tailscale', 'tailscale.exe') : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    const command = {
      command: candidate,
      displayCommand: quoteForWindows(candidate),
    };
    if (commandExistsWithArgs(command, ['version'])) {
      return command;
    }
  }

  return null;
}

function installTailscaleForPlatform(options: { interactive: boolean } = { interactive: false }): InstallAttempt {
  if (process.platform === 'darwin') {
    return installTailscaleWithBrew(options);
  }

  if (process.platform === 'win32') {
    return installTailscaleWithWinget(options);
  }

  if (process.platform === 'linux') {
    return installTailscaleWithOfficialScript(options);
  }

  return {
    attempted: false,
    command: '',
    stdout: '',
    stderr: '',
    reason: `Automatic Tailscale installation is not configured for ${process.platform}.`,
  };
}

function installTailscaleWithBrew(options: { interactive: boolean }): InstallAttempt {
  const brewCommand = resolveBrewCommand();
  const command = `${brewCommand?.displayCommand ?? 'brew'} install --cask tailscale`;
  if (!brewCommand) {
    return {
      attempted: false,
      command,
      stdout: '',
      stderr: '',
      reason: 'Homebrew was not found.',
    };
  }

  const install = options.interactive
    ? runCommandInteractive(brewCommand, ['install', '--cask', 'tailscale'], { timeoutMs: 300000 })
    : runCommand(brewCommand, ['install', '--cask', 'tailscale'], { timeoutMs: 300000 });
  if (install.ok) {
    runCommand('open', ['-a', 'Tailscale'], { timeoutMs: 30000 });
  }

  return {
    attempted: true,
    command,
    stdout: install.stdout,
    stderr: install.stderr,
  };
}

function resolveBrewCommand(): ResolvedCommand | null {
  if (commandExists('brew')) {
    return {
      command: 'brew',
      displayCommand: 'brew',
    };
  }

  for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (!existsSync(candidate)) {
      continue;
    }

    const command = {
      command: candidate,
      displayCommand: quoteForPosix(candidate),
    };
    if (commandExistsWithArgs(command, ['--version'])) {
      return command;
    }
  }

  return null;
}

function installTailscaleWithWinget(options: { interactive: boolean }): InstallAttempt {
  const command = 'winget install --id Tailscale.Tailscale --exact --accept-package-agreements --accept-source-agreements';
  if (!commandExists('winget')) {
    return {
      attempted: false,
      command,
      stdout: '',
      stderr: '',
      reason: 'winget was not found.',
    };
  }

  const args = [
    'install',
    '--id',
    'Tailscale.Tailscale',
    '--exact',
    '--accept-package-agreements',
    '--accept-source-agreements',
  ];
  const install = options.interactive
    ? runCommandInteractive('winget', args, { timeoutMs: 300000 })
    : runCommand('winget', args, { timeoutMs: 300000 });

  return {
    attempted: true,
    command,
    stdout: install.stdout,
    stderr: install.stderr,
  };
}

function installTailscaleWithOfficialScript(options: { interactive: boolean }): InstallAttempt {
  const command = 'curl -fsSL https://tailscale.com/install.sh | sh';
  if (!commandExists('curl')) {
    return {
      attempted: false,
      command,
      stdout: '',
      stderr: '',
      reason: 'curl was not found.',
    };
  }

  const install = options.interactive
    ? runShellCommandInteractive(command, { timeoutMs: 300000 })
    : runShellCommand(command, { timeoutMs: 300000 });
  return {
    attempted: true,
    command,
    stdout: install.stdout,
    stderr: install.stderr,
  };
}

function buildTailscaleInstallError(installAttempt: InstallAttempt): string {
  const lines = [
    'Tailscale is required for cross-device remote setup, but Pane could not find the tailscale CLI after attempting setup.',
  ];

  if (installAttempt.command) {
    lines.push(`Install command: ${installAttempt.command}`);
  }
  if (installAttempt.reason) {
    lines.push(`Reason: ${installAttempt.reason}`);
  }
  if (installAttempt.attempted) {
    lines.push(`Install stdout: ${firstNonEmpty(installAttempt.stdout, '(empty)')}`);
    lines.push(`Install stderr: ${firstNonEmpty(installAttempt.stderr, '(empty)')}`);
  }

  lines.push('');
  lines.push(getTailscaleSetupInstructions());
  return lines.join('\n');
}

function commandExists(command: string): boolean {
  return commandExistsWithArgs(command, ['--version']);
}

function commandExistsWithArgs(command: string | ResolvedCommand, args: string[]): boolean {
  const result = runCommand(command, args);
  return result.ok;
}

function isWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
}

function quoteForPosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteForWindows(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
