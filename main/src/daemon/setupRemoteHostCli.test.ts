import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatSetupRemoteHostResult,
  setupRemoteHost,
} from './setupRemoteHost';
import {
  ensureTailscaleInstalledInteractive,
  runTailscaleUpInteractive,
} from './tailscaleSetup';
import { runRemoteSetupCli } from './setupRemoteHostCli';

vi.mock('./setupRemoteHost', () => ({
  formatSetupRemoteHostResult: vi.fn(() => 'formatted remote setup result'),
  setupRemoteHost: vi.fn(),
}));

vi.mock('./tailscaleSetup', () => ({
  ensureTailscaleInstalledInteractive: vi.fn(),
  runTailscaleUpInteractive: vi.fn(),
}));

describe('runRemoteSetupCli', () => {
  afterEach(() => {
    vi.mocked(formatSetupRemoteHostResult).mockClear();
    vi.mocked(setupRemoteHost).mockReset();
    vi.mocked(ensureTailscaleInstalledInteractive).mockReset();
    vi.mocked(runTailscaleUpInteractive).mockReset();
  });

  it('installs and authenticates Tailscale before running remote setup in interactive mode', async () => {
    const tailscaleCommand = {
      command: 'tailscale',
      displayCommand: 'tailscale',
    };
    vi.mocked(ensureTailscaleInstalledInteractive).mockReturnValue(tailscaleCommand);
    vi.mocked(setupRemoteHost).mockResolvedValue({
      paneDir: '/tmp/pane',
      configPath: '/tmp/pane/config.json',
      label: 'Windows WSL Smoke',
      listenPort: 42139,
      channel: 'stable',
      connectionCode: 'pane-remote://encoded',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        command: 'tailscale serve --bg --tls-terminated-tcp=443 42139',
        note: 'Available through Tailscale Serve.',
      },
      fallbackTunnelCommands: [],
      service: {
        strategy: 'manual',
        installed: false,
        started: false,
        message: 'Service installation disabled',
      },
      manualDaemonCommand: 'pane --daemon-headless',
      wroteConfig: true,
    });

    const exitCode = await runRemoteSetupCli([
      '--interactive-tailscale-setup',
      '--pane-dir',
      '/tmp/pane',
      '--label',
      'Windows WSL Smoke',
      '--listen-port',
      '42139',
      '--prefer-tunnel',
      'tailscale',
      '--no-install-service',
    ]);

    expect(exitCode).toBe(0);
    expect(ensureTailscaleInstalledInteractive).toHaveBeenCalledOnce();
    expect(runTailscaleUpInteractive).toHaveBeenCalledWith(tailscaleCommand);
    expect(setupRemoteHost).toHaveBeenCalledWith(expect.objectContaining({
      paneDir: '/tmp/pane',
      label: 'Windows WSL Smoke',
      listenPort: 42139,
      preferTunnel: 'tailscale',
      installService: false,
      interactiveTailscaleSetup: true,
    }));
    expect(formatSetupRemoteHostResult).toHaveBeenCalledOnce();
  });
});
