import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultCloudVmState,
  normalizeCloudVmConfig,
  type CloudVmConfig,
} from '../../../shared/types/cloud';
import { CloudVmManager } from './cloudVmManager';

class ConfigManagerStub extends EventEmitter {
  constructor(private readonly cloud?: CloudVmConfig) {
    super();
  }

  getConfig(): { cloud?: CloudVmConfig } {
    return { cloud: this.cloud };
  }
}

describe('normalizeCloudVmConfig', () => {
  it('adds hosted-workspace defaults while preserving existing legacy cloud fields', () => {
    expect(normalizeCloudVmConfig({
      provider: 'gcp',
      apiToken: 'secret-token',
      serverId: 'pane-user123',
      projectId: 'pane-cloud-user123',
      zone: 'us-central1-a',
      tunnelPort: 9000,
      linkedRemoteProfileId: 'remote-profile-1',
      daemonBaseUrl: 'http://127.0.0.1:42137',
      daemonStatus: 'ready',
      preferredAccess: 'novnc',
      allowNoVncFallback: false,
    })).toEqual({
      provider: 'gcp',
      apiToken: 'secret-token',
      serverId: 'pane-user123',
      projectId: 'pane-cloud-user123',
      zone: 'us-central1-a',
      tunnelPort: 9000,
      tunnelStatus: 'off',
      daemonStatus: 'ready',
      daemonBaseUrl: 'http://127.0.0.1:42137',
      linkedRemoteProfileId: 'remote-profile-1',
      preferredAccess: 'novnc',
      allowNoVncFallback: false,
      serverIp: undefined,
      vncPassword: undefined,
      region: undefined,
    });
  });

  it('falls back to daemon-first hosted defaults for legacy or invalid values', () => {
    expect(normalizeCloudVmConfig({
      provider: 'gcp',
      apiToken: 'legacy-token',
      daemonStatus: 'bogus',
      preferredAccess: 'desktop-stream',
      daemonBaseUrl: '   ',
      linkedRemoteProfileId: '',
    })).toEqual({
      provider: 'gcp',
      apiToken: 'legacy-token',
      tunnelPort: 8080,
      tunnelStatus: 'off',
      daemonStatus: 'unknown',
      daemonBaseUrl: undefined,
      linkedRemoteProfileId: undefined,
      preferredAccess: 'daemon',
      allowNoVncFallback: true,
      serverId: undefined,
      serverIp: undefined,
      vncPassword: undefined,
      region: undefined,
      projectId: undefined,
      zone: undefined,
    });
  });

  it('accepts numeric string tunnel ports written by shell tooling', () => {
    expect(normalizeCloudVmConfig({
      provider: 'gcp',
      apiToken: 'legacy-token',
      tunnelPort: '9000',
    }).tunnelPort).toBe(9000);
  });
});

describe('CloudVmManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the default hosted workspace state when cloud is not configured', async () => {
    const manager = new CloudVmManager(new ConfigManagerStub() as never);

    await expect(manager.getState()).resolves.toEqual(createDefaultCloudVmState());
  });

  it('includes hosted workspace metadata in state snapshots', async () => {
    const manager = new CloudVmManager(new ConfigManagerStub(normalizeCloudVmConfig({
      provider: 'gcp',
      apiToken: 'secret-token',
      serverId: 'pane-user123',
      projectId: 'pane-project',
      zone: 'us-central1-a',
      vncPassword: 'vnc-password',
      tunnelPort: 8080,
      daemonStatus: 'ready',
      daemonBaseUrl: 'http://127.0.0.1:42137',
      linkedRemoteProfileId: 'remote-profile-1',
      preferredAccess: 'daemon',
      allowNoVncFallback: false,
    })) as never);

    vi.spyOn(manager as never, 'fetchVmStatus').mockResolvedValue('running');
    vi.spyOn(manager as never, 'checkTunnelHealth').mockResolvedValue(true);

    const state = await manager.getState();

    expect(state).toMatchObject({
      status: 'running',
      provider: 'gcp',
      serverId: 'pane-user123',
      tunnelStatus: 'running',
      daemonStatus: 'ready',
      daemonBaseUrl: 'http://127.0.0.1:42137',
      linkedRemoteProfileId: 'remote-profile-1',
      preferredAccess: 'daemon',
      allowNoVncFallback: false,
      error: null,
    });
    expect(state.noVncUrl).toContain('http://localhost:8080/novnc/vnc.html');
  });

  it('surfaces daemon-backed hosted workspace state without requiring a local cloud API token', async () => {
    const manager = new CloudVmManager(new ConfigManagerStub(normalizeCloudVmConfig({
      provider: 'gcp',
      serverId: 'pane-user123',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
    })) as never);

    const fetchVmStatusSpy = vi.spyOn(manager as never, 'fetchVmStatus');

    const state = await manager.getState();

    expect(fetchVmStatusSpy).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      status: 'running',
      provider: 'gcp',
      serverId: 'pane-user123',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
      preferredAccess: 'daemon',
      allowNoVncFallback: true,
      noVncUrl: null,
      tunnelStatus: 'off',
      error: null,
    });
  });

  it('surfaces daemon-backed hosted workspace state when lifecycle fields are incomplete', async () => {
    const manager = new CloudVmManager(new ConfigManagerStub(normalizeCloudVmConfig({
      provider: 'gcp',
      apiToken: 'stale-token',
      serverId: 'pane-user123',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
    })) as never);

    const fetchVmStatusSpy = vi.spyOn(manager as never, 'fetchVmStatus');

    const state = await manager.getState();

    expect(fetchVmStatusSpy).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      status: 'running',
      provider: 'gcp',
      serverId: 'pane-user123',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
      tunnelStatus: 'off',
      error: null,
    });
  });

  it('falls back to daemon-backed hosted workspace state when lifecycle status fetch fails', async () => {
    const manager = new CloudVmManager(new ConfigManagerStub(normalizeCloudVmConfig({
      provider: 'gcp',
      apiToken: 'stale-token',
      serverId: 'pane-user123',
      projectId: 'pane-project',
      zone: 'us-central1-a',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
    })) as never);

    vi.spyOn(manager as never, 'fetchVmStatus').mockRejectedValue(new Error('401 Unauthorized'));

    const state = await manager.getState();

    expect(state).toMatchObject({
      status: 'running',
      provider: 'gcp',
      serverId: 'pane-user123',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
      tunnelStatus: 'off',
      error: null,
    });
  });
});
