import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePaneRemoteConnection } from '../../../shared/types/remoteDaemon';
import { setupRemoteHost } from './setupRemoteHost';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: spawnSyncMock,
}));

function commandResult(options: {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}) {
  return {
    status: options.status,
    stdout: options.stdout ?? '',
    stderr: options.stderr ?? '',
    error: options.error,
  };
}

function missingCommandResult(command: string) {
  const error = Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });
  return commandResult({ status: null, error });
}

describe('setupRemoteHost', () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
  });

  it('requires Tailscale by default for cross-device setup', async () => {
    spawnSyncMock.mockReturnValue(missingCommandResult('tailscale'));

    await expect(setupRemoteHost({
      paneDir: path.join(os.tmpdir(), 'pane-remote-missing-tailscale'),
      installService: false,
    })).rejects.toThrow('Tailscale is required for cross-device remote setup, but the tailscale CLI was not found.');

    expect(spawnSyncMock).toHaveBeenCalledWith('tailscale', ['--version'], expect.any(Object));
  });

  it('uses a Tailscale Serve HTTPS URL for the generated connection code', async () => {
    const paneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-remote-tailscale-'));
    try {
      spawnSyncMock.mockImplementation((command: string, args: string[]) => {
        if (command === 'tailscale' && args[0] === '--version') {
          return commandResult({ status: 0, stdout: '1.80.0\n' });
        }
        if (command === 'tailscale' && args[0] === 'serve' && args[1] === '--bg') {
          return commandResult({
            status: 0,
            stdout: 'Available within your tailnet:\nhttps://office-mac.tailnet.ts.net\n',
          });
        }
        if (command === 'tailscale' && args[0] === 'serve' && args[1] === 'status') {
          return commandResult({
            status: 0,
            stdout: 'https://office-mac.tailnet.ts.net proxy http://127.0.0.1:42137\n',
          });
        }

        return missingCommandResult(command);
      });

      const result = await setupRemoteHost({
        paneDir,
        label: 'Office Mac',
        installService: false,
      });
      const payload = decodePaneRemoteConnection(result.connectionCode);
      const config = JSON.parse(await fs.readFile(path.join(paneDir, 'config.json'), 'utf8')) as {
        remoteDaemon: {
          host: {
            config: {
              enabled: boolean;
              listenHost: string;
              listenPort: number;
            };
          };
        };
      };

      expect(result.tunnel?.kind).toBe('tailscale');
      expect(result.tunnel?.command).toBe('tailscale serve --bg http://127.0.0.1:42137');
      expect(payload.baseUrl).toBe('https://office-mac.tailnet.ts.net');
      expect(payload.tunnel?.kind).toBe('tailscale');
      expect(config.remoteDaemon.host.config).toMatchObject({
        enabled: true,
        listenHost: '127.0.0.1',
        listenPort: 42137,
      });
    } finally {
      await fs.rm(paneDir, { recursive: true, force: true });
    }
  });

  it('keeps SSH tunnel setup available only when explicitly selected', async () => {
    const result = await setupRemoteHost({
      printOnly: true,
      preferTunnel: 'ssh',
      installService: false,
    });
    const payload = decodePaneRemoteConnection(result.connectionCode);

    expect(payload.baseUrl).toBe('http://127.0.0.1:42137');
    expect(payload.tunnel?.kind).toBe('ssh');
    expect(payload.tunnel?.command).toContain('ssh -N -L 42137:127.0.0.1:42137');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('requires a manual HTTPS base URL when manual mode is selected', async () => {
    await expect(setupRemoteHost({
      printOnly: true,
      preferTunnel: 'manual',
      installService: false,
    })).rejects.toThrow('Manual HTTPS remote setup requires a base URL.');
  });
});
