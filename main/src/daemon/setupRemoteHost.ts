import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  DEFAULT_REMOTE_DAEMON_HOST_CONFIG,
  encodePaneRemoteConnection,
  normalizeRemoteDaemonConfig,
  type PaneRemoteConnectionImportPayload,
  type RemoteHostSetupRequest,
  type RemoteHostSetupServiceResult,
  type RemoteHostSetupResult,
  type RemoteDaemonConfig,
  type RemoteSetupTunnelPreference,
} from '../../../shared/types/remoteDaemon';
import {
  createPaneRemoteConnectionImportPayload,
  createRemoteDaemonConnectionPair,
} from './remotePairing';

export interface SetupRemoteHostOptions extends Omit<RemoteHostSetupRequest, 'dataDirectoryMode'> {
  printOnly?: boolean;
  existingConfig?: unknown;
  writeConfig?: (config: Record<string, unknown>) => Promise<void>;
}

export type SetupRemoteHostResult = Omit<RemoteHostSetupResult, 'dataDirectoryMode'>;

type ServiceSetupResult = RemoteHostSetupServiceResult;

interface TunnelSelection {
  baseUrl: string;
  tunnel: PaneRemoteConnectionImportPayload['tunnel'];
  fallbackCommands: string[];
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface ResolvedCommand {
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

const DEFAULT_REMOTE_PANE_DIR = '.pane_remote';
const SERVICE_NAME = 'com.dcouple.pane.remote-daemon';
const WINDOWS_TASK_NAME = 'PaneRemoteDaemon';
const DEFAULT_TUNNEL_PREFERENCE: RemoteSetupTunnelPreference = 'tailscale';

export async function setupRemoteHost(options: SetupRemoteHostOptions = {}): Promise<SetupRemoteHostResult> {
  const paneDir = path.resolve(options.paneDir ?? process.env.PANE_DIR ?? path.join(os.homedir(), DEFAULT_REMOTE_PANE_DIR));
  const configPath = path.join(paneDir, 'config.json');
  const listenPort = normalizePort(options.listenPort ?? DEFAULT_REMOTE_DAEMON_HOST_CONFIG.listenPort);
  const label = normalizeLabel(options.label);
  const channel = options.channel ?? 'stable';
  const manualDaemonCommand = buildHeadlessDaemonCommand(paneDir);
  const tunnelSelection = selectTunnel({
    listenPort,
    preferTunnel: options.preferTunnel ?? DEFAULT_TUNNEL_PREFERENCE,
    exposeTailscale: options.exposeTailscale !== false,
    printOnly: options.printOnly === true,
    manualBaseUrl: options.baseUrl,
  });
  const pair = createRemoteDaemonConnectionPair({
    label,
    baseUrl: tunnelSelection.baseUrl,
  });
  const importPayload = createPaneRemoteConnectionImportPayload(pair, tunnelSelection.tunnel);
  const connectionCode = encodePaneRemoteConnection(importPayload);

  let wroteConfig = false;
  if (!options.printOnly) {
    const existingConfig = isRecord(options.existingConfig)
      ? options.existingConfig
      : await readConfigFile(configPath);
    const nextRemoteDaemon = buildNextRemoteDaemonConfig(existingConfig.remoteDaemon, pair.client, listenPort);
    const nextConfig = {
      ...existingConfig,
      remoteDaemon: nextRemoteDaemon,
    };
    if (options.writeConfig) {
      await options.writeConfig(nextConfig);
    } else {
      await writeConfigFileAtomically(paneDir, configPath, nextConfig);
    }
    wroteConfig = true;
  }

  const service = options.printOnly || options.installService === false
    ? {
        strategy: options.printOnly ? 'skipped' : 'manual',
        installed: false,
        started: false,
        message: options.printOnly
          ? 'Print-only mode did not write config or install a daemon service.'
          : 'Service installation disabled; use the manual daemon command.',
      } satisfies ServiceSetupResult
    : await installBestAvailableService({
        paneDir,
        manualDaemonCommand,
      });

  return {
    paneDir,
    configPath,
    label,
    listenPort,
    channel,
    ...(options.repoRef ? { repoRef: options.repoRef } : {}),
    connectionCode,
    tunnel: tunnelSelection.tunnel,
    fallbackTunnelCommands: tunnelSelection.fallbackCommands,
    service,
    manualDaemonCommand,
    wroteConfig,
  };
}

export function formatSetupRemoteHostResult(result: SetupRemoteHostResult): string {
  const lines = [
    'Pane remote daemon setup',
    `Data directory: ${result.paneDir}`,
    `Config: ${result.configPath}`,
    `Channel: ${result.channel}${result.repoRef ? ` (${result.repoRef})` : ''}`,
    `Service: ${result.service.strategy} - ${result.service.message}`,
    `Config written: ${result.wroteConfig ? 'yes' : 'no'}`,
    '',
    'Connection code:',
    result.connectionCode,
    '',
  ];

  if (result.tunnel?.command) {
    lines.push('Connection/tunnel command:');
    lines.push(result.tunnel.command);
    lines.push('');
  }

  if (result.tunnel?.note) {
    lines.push(`Connection note: ${result.tunnel.note}`);
    lines.push('');
  }

  const fallbackCommands = result.fallbackTunnelCommands.filter((command) => command !== result.tunnel?.command);
  if (fallbackCommands.length > 0) {
    lines.push('Fallback tunnel options:');
    for (const command of fallbackCommands) {
      lines.push(command);
    }
    lines.push('');
  }

  if (!result.service.started) {
    lines.push('Manual daemon command:');
    lines.push(result.manualDaemonCommand);
    lines.push('');
  }

  lines.push('Paste the full pane-remote:// code into Pane Settings > Self-Hosted Remote Daemon > Import Remote Connection.');
  return lines.join('\n');
}

function buildNextRemoteDaemonConfig(
  value: unknown,
  client: RemoteDaemonConfig['host']['clients'][number],
  listenPort: number,
): RemoteDaemonConfig {
  const current = normalizeRemoteDaemonConfig(value);
  return normalizeRemoteDaemonConfig({
    ...current,
    host: {
      ...current.host,
      config: {
        ...current.host.config,
        enabled: true,
        listenHost: DEFAULT_REMOTE_DAEMON_HOST_CONFIG.listenHost,
        listenPort,
        pairingRequired: true,
        allowInsecureHttpOnLoopback: true,
      },
      clients: upsertById(current.host.clients, client),
    },
  });
}

async function readConfigFile(configPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return {};
    }
    throw error;
  }
}

async function writeConfigFileAtomically(
  paneDir: string,
  configPath: string,
  config: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(paneDir, { recursive: true });
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, configPath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

function selectTunnel(options: {
  listenPort: number;
  preferTunnel: RemoteSetupTunnelPreference;
  exposeTailscale: boolean;
  printOnly: boolean;
  manualBaseUrl?: string;
}): TunnelSelection {
  const sshCommand = buildSshForwardCommand(options.listenPort);
  const fallbackCommands = [sshCommand, buildTailscaleServeCommand(null, options.listenPort)];
  const manualBaseUrl = options.manualBaseUrl?.trim();

  if (manualBaseUrl) {
    return {
      baseUrl: manualBaseUrl,
      fallbackCommands,
      tunnel: {
        kind: 'manual',
        selected: true,
        note: 'Use the configured HTTPS tunnel or reverse proxy before connecting.',
      },
    };
  }

  if (options.preferTunnel === 'manual') {
    throw new Error('Manual HTTPS remote setup requires a base URL. Use an HTTPS tunnel or choose SSH Tunnel for local forwarding.');
  }

  if (options.preferTunnel === 'ssh') {
    return {
      baseUrl: `http://127.0.0.1:${options.listenPort}`,
      fallbackCommands,
      tunnel: {
        kind: 'ssh',
        selected: true,
        command: sshCommand,
        note: 'Run this SSH tunnel command on the client machine before connecting. SSH tunnel mode is intended for advanced local forwarding, not zero-config cross-device setup.',
      },
    };
  }

  if (options.preferTunnel === 'tailscale' || options.preferTunnel === 'auto') {
    const initialTailscaleCli = resolveTailscaleCommand();
    const tailscaleCommand = buildTailscaleServeCommand(initialTailscaleCli, options.listenPort);
    return selectTailscaleTunnel({
      listenPort: options.listenPort,
      exposeTailscale: options.exposeTailscale,
      printOnly: options.printOnly,
      tailscaleCli: initialTailscaleCli,
      tailscaleCommand,
      fallbackCommands: [sshCommand, tailscaleCommand],
    });
  }

  return assertNeverTunnelPreference(options.preferTunnel);
}

function selectTailscaleTunnel(options: {
  listenPort: number;
  exposeTailscale: boolean;
  printOnly: boolean;
  tailscaleCli: ResolvedCommand | null;
  tailscaleCommand: string;
  fallbackCommands: string[];
}): TunnelSelection {
  if (!options.exposeTailscale) {
    throw new Error(`Tailscale is required for cross-device remote setup. Remove --no-tailscale-serve or choose SSH Tunnel under advanced options.\n\n${getTailscaleSetupInstructions()}`);
  }

  if (options.printOnly) {
    throw new Error('Tailscale setup cannot run in print-only mode because Pane must configure Tailscale Serve before it can create a cross-device connection code.');
  }

  const tailscaleCli = options.tailscaleCli ?? installTailscaleCommandOrThrow();
  const tailscaleCommand = buildTailscaleServeCommand(tailscaleCli, options.listenPort);

  const tailscaleServe = runCommand(tailscaleCli, ['serve', '--bg', `http://127.0.0.1:${options.listenPort}`]);
  if (!tailscaleServe.ok) {
    throw new Error(`Tailscale Serve setup failed: ${firstNonEmpty(tailscaleServe.stderr, tailscaleServe.stdout, 'unknown error')}\n\n${getTailscaleSetupInstructions()}`);
  }

  const serveStatus = runCommand(tailscaleCli, ['serve', 'status']);
  const serveUrl = extractFirstHttpsUrl([
    tailscaleServe.stdout,
    tailscaleServe.stderr,
    serveStatus.ok ? serveStatus.stdout : '',
    serveStatus.ok ? serveStatus.stderr : '',
  ].join('\n'));

  if (!serveUrl) {
    throw new Error(`Tailscale Serve was configured, but Pane could not find an HTTPS Tailscale URL in the command output. Run "${tailscaleCommand}" manually and confirm Tailscale is logged in.\n\n${getTailscaleSetupInstructions()}`);
  }

  return {
    baseUrl: serveUrl,
    fallbackCommands: options.fallbackCommands.includes(tailscaleCommand)
      ? options.fallbackCommands
      : [options.fallbackCommands[0], tailscaleCommand],
    tunnel: {
      kind: 'tailscale',
      selected: true,
      command: tailscaleCommand,
      note: 'Tailscale Serve is configured for this tailnet. Keep Pane running on this host when using current data mode.',
    },
  };
}

function assertNeverTunnelPreference(value: never): never {
  throw new Error(`Unsupported remote setup tunnel preference: ${String(value)}`);
}

async function installBestAvailableService(options: {
  paneDir: string;
  manualDaemonCommand: string;
}): Promise<ServiceSetupResult> {
  if (process.platform === 'linux' && commandExists('systemctl')) {
    return installSystemdUserService(options);
  }

  if (process.platform === 'darwin' && commandExists('launchctl')) {
    return installLaunchAgent(options);
  }

  if (process.platform === 'win32' && commandExists('schtasks')) {
    return installWindowsScheduledTask(options);
  }

  return {
    strategy: 'manual',
    installed: false,
    started: false,
    message: 'No supported user-level service manager detected; use the manual daemon command.',
  };
}

async function installSystemdUserService(options: {
  paneDir: string;
  manualDaemonCommand: string;
}): Promise<ServiceSetupResult> {
  const launcherPath = await writePosixLauncher(options.paneDir, options.manualDaemonCommand);
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDir, 'pane-remote-daemon.service');
  const serviceFile = [
    '[Unit]',
    'Description=Pane Remote Daemon',
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `Environment=${quoteForSystemd(`PANE_DIR=${options.paneDir}`)}`,
    `ExecStart=${quoteForSystemd(launcherPath)}`,
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');

  await fs.mkdir(serviceDir, { recursive: true });
  await fs.writeFile(servicePath, serviceFile, 'utf8');

  const daemonReload = runCommand('systemctl', ['--user', 'daemon-reload']);
  const enable = daemonReload.ok
    ? runCommand('systemctl', ['--user', 'enable', '--now', 'pane-remote-daemon.service'])
    : daemonReload;

  return {
    strategy: 'systemd-user',
    installed: enable.ok,
    started: enable.ok,
    message: enable.ok
      ? 'Installed and started a user systemd service.'
      : `Wrote ${servicePath}, but systemctl failed: ${firstNonEmpty(enable.stderr, enable.stdout, 'unknown error')}`,
  };
}

async function installLaunchAgent(options: {
  paneDir: string;
  manualDaemonCommand: string;
}): Promise<ServiceSetupResult> {
  const agentDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(agentDir, `${SERVICE_NAME}.plist`);
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(SERVICE_NAME)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    '    <string>-lc</string>',
    `    <string>${escapeXml(options.manualDaemonCommand)}</string>`,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PANE_DIR</key>',
    `    <string>${escapeXml(options.paneDir)}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');

  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(plistPath, plist, 'utf8');
  runCommand('launchctl', ['unload', '-w', plistPath]);
  const load = runCommand('launchctl', ['load', '-w', plistPath]);

  return {
    strategy: 'launch-agent',
    installed: load.ok,
    started: load.ok,
    message: load.ok
      ? 'Installed and started a LaunchAgent.'
      : `Wrote ${plistPath}, but launchctl failed: ${firstNonEmpty(load.stderr, load.stdout, 'unknown error')}`,
  };
}

async function installWindowsScheduledTask(options: {
  paneDir: string;
  manualDaemonCommand: string;
}): Promise<ServiceSetupResult> {
  await writeWindowsLauncher(options.paneDir, options.manualDaemonCommand);
  const create = runCommand('schtasks', [
    '/Create',
    '/TN',
    WINDOWS_TASK_NAME,
    '/TR',
    `cmd.exe /d /c ${options.manualDaemonCommand}`,
    '/SC',
    'ONLOGON',
    '/F',
  ]);
  const run = create.ok
    ? runCommand('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME])
    : create;

  return {
    strategy: 'scheduled-task',
    installed: create.ok,
    started: run.ok,
    message: create.ok && run.ok
      ? 'Installed and started a per-user Scheduled Task.'
      : `Scheduled Task setup failed: ${firstNonEmpty(run.stderr, run.stdout, 'unknown error')}`,
  };
}

async function writePosixLauncher(paneDir: string, command: string): Promise<string> {
  const scriptDir = path.join(paneDir, 'remote-daemon');
  const scriptPath = path.join(scriptDir, 'start.sh');
  await fs.mkdir(scriptDir, { recursive: true });
  await fs.writeFile(scriptPath, [
    '#!/usr/bin/env sh',
    'set -eu',
    `export PANE_DIR=${quoteForPosix(paneDir)}`,
    `exec /bin/sh -lc ${quoteForPosix(command)}`,
    '',
  ].join('\n'), 'utf8');
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

async function writeWindowsLauncher(paneDir: string, command: string): Promise<string> {
  const scriptDir = path.join(paneDir, 'remote-daemon');
  const scriptPath = path.join(scriptDir, 'start.cmd');
  await fs.mkdir(scriptDir, { recursive: true });
  await fs.writeFile(scriptPath, [
    '@echo off',
    `set "PANE_DIR=${paneDir}"`,
    command,
    '',
  ].join('\r\n'), 'utf8');
  return scriptPath;
}

function buildHeadlessDaemonCommand(paneDir: string): string {
  const sourceRoot = findSourceRoot(process.cwd());
  if (sourceRoot) {
    if (process.platform === 'win32') {
      return `cd /d ${quoteForWindows(sourceRoot)} && set "PANE_DIR=${paneDir}" && pnpm daemon:headless -- --pane-dir ${quoteForWindows(paneDir)}`;
    }
    return `cd ${quoteForPosix(sourceRoot)} && ${buildPosixHeadlessEnvironment(paneDir)} pnpm daemon:headless -- --pane-dir ${quoteForPosix(paneDir)}`;
  }

  if (process.platform === 'win32') {
    return `${quoteForWindows(process.execPath)} --daemon-headless --pane-dir ${quoteForWindows(paneDir)}`;
  }

  return `${buildPosixHeadlessEnvironment(paneDir)} ${quoteForPosix(process.execPath)} --daemon-headless --pane-dir ${quoteForPosix(paneDir)}`;
}

function buildPosixHeadlessEnvironment(paneDir: string): string {
  const entries = [`PANE_DIR=${quoteForPosix(paneDir)}`];
  if (process.platform === 'linux') {
    entries.push('ELECTRON_OZONE_PLATFORM_HINT=headless');
  }
  return entries.join(' ');
}

function findSourceRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const packagePath = path.join(current, 'package.json');
    if (existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as unknown;
        if (isRecord(parsed) && parsed.name === 'Pane') {
          return current;
        }
      } catch {
        return null;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function buildSshForwardCommand(port: number): string {
  const username = safeUsername();
  const hostname = os.hostname();
  return `ssh -N -L ${port}:127.0.0.1:${port} ${username}@${hostname}`;
}

function safeUsername(): string {
  try {
    return os.userInfo().username || 'user';
  } catch {
    return 'user';
  }
}

function normalizeLabel(label: string | undefined): string {
  const trimmed = label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : `${os.hostname()} Pane daemon`;
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error('Remote daemon listen port must be between 1 and 65535');
  }
  return value;
}

function buildTailscaleServeCommand(command: ResolvedCommand | null, port: number): string {
  return `${command?.displayCommand ?? 'tailscale'} serve --bg http://127.0.0.1:${port}`;
}

function installTailscaleCommandOrThrow(): ResolvedCommand {
  const installAttempt = installTailscaleForPlatform();
  const resolvedCommand = resolveTailscaleCommand();
  if (resolvedCommand) {
    return resolvedCommand;
  }

  throw new Error(buildTailscaleInstallError(installAttempt));
}

function resolveTailscaleCommand(): ResolvedCommand | null {
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

function installTailscaleForPlatform(): InstallAttempt {
  if (process.platform === 'darwin') {
    return installTailscaleWithBrew();
  }

  if (process.platform === 'win32') {
    return installTailscaleWithWinget();
  }

  if (process.platform === 'linux') {
    return installTailscaleWithOfficialScript();
  }

  return {
    attempted: false,
    command: '',
    stdout: '',
    stderr: '',
    reason: `Automatic Tailscale installation is not configured for ${process.platform}.`,
  };
}

function installTailscaleWithBrew(): InstallAttempt {
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

  const install = runCommand(brewCommand, ['install', '--cask', 'tailscale'], { timeoutMs: 300000 });
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

function installTailscaleWithWinget(): InstallAttempt {
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

  const install = runCommand('winget', [
    'install',
    '--id',
    'Tailscale.Tailscale',
    '--exact',
    '--accept-package-agreements',
    '--accept-source-agreements',
  ], { timeoutMs: 300000 });

  return {
    attempted: true,
    command,
    stdout: install.stdout,
    stderr: install.stderr,
  };
}

function installTailscaleWithOfficialScript(): InstallAttempt {
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

  const install = runShellCommand(command, { timeoutMs: 300000 });
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
    '',
  ];

  if (installAttempt.command) {
    lines.push(installAttempt.attempted ? 'Pane attempted:' : 'Pane wanted to run:');
    lines.push(installAttempt.command);
    lines.push('');
  }

  if (installAttempt.reason) {
    lines.push(installAttempt.reason);
    lines.push('');
  }

  const output = firstNonEmpty(installAttempt.stderr, installAttempt.stdout);
  if (output) {
    lines.push(output);
    lines.push('');
  }

  lines.push(getTailscaleSetupInstructions());
  return lines.join('\n');
}

function commandExists(command: string): boolean {
  return commandExistsWithArgs(command, ['--version']);
}

function commandExistsWithArgs(command: string | ResolvedCommand, args: string[]): boolean {
  const resolvedCommand = typeof command === 'string'
    ? { command, env: undefined }
    : command;
  const result = spawnSync(resolvedCommand.command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    env: resolvedCommand.env,
  });
  if (!result) {
    return false;
  }
  return result.status === 0 || result.error === undefined && typeof result.status === 'number';
}

function runCommand(
  command: string | ResolvedCommand,
  args: string[],
  options: { timeoutMs?: number } = {},
): CommandResult {
  const resolvedCommand = typeof command === 'string'
    ? { command, env: undefined }
    : command;
  const result = spawnSync(resolvedCommand.command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    env: resolvedCommand.env,
    timeout: options.timeoutMs,
  });

  return {
    ok: result.status === 0,
    stdout: commandOutputToString(result.stdout),
    stderr: commandOutputToString(result.stderr) || (result.error ? result.error.message : ''),
  };
}

function runShellCommand(command: string, options: { timeoutMs?: number } = {}): CommandResult {
  if (process.platform === 'win32') {
    return runCommand('cmd.exe', ['/d', '/s', '/c', command], options);
  }

  return runCommand('/bin/sh', ['-lc', command], options);
}

function commandOutputToString(value: string | Buffer | null): string {
  if (typeof value === 'string') {
    return value;
  }

  return value ? value.toString('utf8') : '';
}

function extractFirstHttpsUrl(output: string): string | null {
  const match = output.match(/https:\/\/[^\s|"'<>]+/);
  if (!match) {
    return null;
  }

  return match[0].replace(/[),.]+$/g, '');
}

function getTailscaleSetupInstructions(): string {
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

function isWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function upsertById<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);
  if (existingIndex === -1) {
    return [...items, nextItem];
  }

  return items.map((item, index) => (index === existingIndex ? nextItem : item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function quoteForPosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteForWindows(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function quoteForSystemd(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim().length > 0)?.trim() ?? '';
}
