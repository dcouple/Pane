import {
  formatSetupRemoteHostResult,
  setupRemoteHost,
  type SetupRemoteHostOptions,
} from './setupRemoteHost';
import type {
  RemoteSetupChannel,
  RemoteSetupTunnelPreference,
} from '../../../shared/types/remoteDaemon';

export async function runRemoteSetupCli(args = process.argv.slice(2)): Promise<number> {
  try {
    if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
      console.log(getUsageText());
      return 0;
    }

    const options = parseSetupRemoteHostArgs(args);
    const result = await setupRemoteHost(options);
    console.log(formatSetupRemoteHostResult(result));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Pane remote setup failed');
    return 1;
  }
}

function parseSetupRemoteHostArgs(args: string[]): SetupRemoteHostOptions {
  const listenPortValue = readArgValue(args, '--listen-port') ?? readArgValue(args, '--port');
  const channel = parseChannel(readArgValue(args, '--channel'));
  const preferTunnel = parseTunnelPreference(readArgValue(args, '--prefer-tunnel'));

  return {
    paneDir: readArgValue(args, '--pane-dir'),
    label: readArgValue(args, '--label'),
    listenPort: listenPortValue ? Number.parseInt(listenPortValue, 10) : undefined,
    channel,
    repoRef: readArgValue(args, '--repo-ref'),
    printOnly: hasFlag(args, '--print-only'),
    installService: !hasFlag(args, '--no-install-service'),
    exposeTailscale: !hasFlag(args, '--no-tailscale-serve'),
    preferTunnel,
  };
}

function parseChannel(value: string | undefined): RemoteSetupChannel | undefined {
  if (!value) {
    return undefined;
  }

  if (value === 'stable' || value === 'nightly') {
    return value;
  }

  throw new Error('--channel must be "stable" or "nightly"');
}

function parseTunnelPreference(value: string | undefined): RemoteSetupTunnelPreference | undefined {
  if (!value) {
    return undefined;
  }

  if (value === 'auto' || value === 'tailscale' || value === 'ssh' || value === 'manual') {
    return value;
  }

  throw new Error('--prefer-tunnel must be "auto", "tailscale", "ssh", or "manual"');
}

function readArgValue(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
    if (arg === name && index + 1 < args.length) {
      return args[index + 1];
    }
  }

  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function getUsageText(): string {
  return [
    'Pane remote setup',
    '',
    'Usage:',
    '  pane --remote-setup [options]',
    '  pnpm remote:setup -- [options]',
    '',
    'Options:',
    '  --pane-dir <path>             Data directory for the remote daemon (default: ~/.pane_remote)',
    '  --label <name>                Label shown in local Pane after import',
    '  --listen-port <port>          Loopback daemon port (default: 42137)',
    '  --channel <stable|nightly>    Release channel metadata for website bootstrap validation',
    '  --repo-ref <ref>              Source ref metadata for validation builds',
    '  --prefer-tunnel <mode>        auto, tailscale, ssh, or manual (default: auto)',
    '  --no-install-service          Write config and print manual daemon command without installing startup service',
    '  --no-tailscale-serve          Do not attempt to configure Tailscale Serve',
    '  --print-only                  Generate output without writing config, installing service, or configuring tunnels',
    '',
  ].join('\n');
}

if (require.main === module) {
  void runRemoteSetupCli().then((exitCode) => {
    process.exit(exitCode);
  });
}
