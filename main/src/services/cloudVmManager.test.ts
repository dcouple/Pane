import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultCloudVmState,
  normalizeCloudVmConfig,
  type CloudVmConfig,
  type CloudVmState,
  type VmStatus,
} from '../../../shared/types/cloud';
import {
  createDefaultRemoteDaemonConfig,
  type RemoteDaemonConfig,
} from '../../../shared/types/remoteDaemon';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { CloudVmManager } from './cloudVmManager';
import type { ConfigManager } from './configManager';

interface CloudVmManagerTestAccess {
  fetchVmStatus(config: CloudVmConfig): Promise<VmStatus>;
  checkTunnelHealth(port: number): Promise<boolean>;
  gcpAction(config: CloudVmConfig, action: 'start' | 'stop'): Promise<void>;
  waitForStatus(config: CloudVmConfig, targetStatus: VmStatus, timeoutMs: number): Promise<CloudVmState>;
}

function createManager(configManager: ConfigManagerStub): CloudVmManager {
  // SAFETY: The stub implements the EventEmitter and configuration methods
  // CloudVmManager reaches in these isolated lifecycle tests.
  return new CloudVmManager(configManager as ConfigManager);
}

function managerAccess(manager: CloudVmManager): CloudVmManagerTestAccess {
  // SAFETY: This interface mirrors only the private lifecycle methods that
  // these tests intentionally replace with deterministic spies.
  return manager as CloudVmManagerTestAccess;
}

class ConfigManagerStub extends EventEmitter {
  constructor(
    private cloud?: CloudVmConfig,
    private remoteDaemon: RemoteDaemonConfig = createDefaultRemoteDaemonConfig(),
  ) {
    super();
  }

  getConfig(): { cloud?: CloudVmConfig; remoteDaemon?: RemoteDaemonConfig } {
    return { cloud: this.cloud, remoteDaemon: this.remoteDaemon };
  }

  async updateConfig(
    updates: { cloud?: CloudVmConfig; remoteDaemon?: RemoteDaemonConfig },
  ): Promise<{ cloud?: CloudVmConfig; remoteDaemon?: RemoteDaemonConfig }> {
    if ('cloud' in updates) {
      this.cloud = updates.cloud;
    }
    if ('remoteDaemon' in updates && updates.remoteDaemon) {
      this.remoteDaemon = updates.remoteDaemon;
    }
    this.emit('config-updated', this.getConfig());
    return this.getConfig();
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

  it('preserves normalized configuration across repeated normalization', () => {
    const normalized = normalizeCloudVmConfig({
      provider: 'gcp',
      apiToken: 'secret-token',
      serverId: 'pane-user123',
      projectId: 'pane-cloud-user123',
    });

    expect(normalizeCloudVmConfig(normalized)).toEqual(normalized);
  });
});

describe('CloudVmManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the default hosted workspace state when cloud is not configured', async () => {
    const manager = createManager(new ConfigManagerStub());

    await expect(manager.getState()).resolves.toEqual(createDefaultCloudVmState());
  });

  it('includes hosted workspace metadata in state snapshots', async () => {
    const remoteDaemonConfig = createDefaultRemoteDaemonConfig();
    remoteDaemonConfig.client.profiles = [{
      id: 'remote-profile-1',
      label: 'Pane Cloud Workspace',
      baseUrl: 'http://127.0.0.1:42137',
      token: 'secret-token',
      transport: 'http+sse',
    }];
    vi.spyOn(remotePaneClientController, 'getConnectionState').mockReturnValue({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });

    const manager = createManager(new ConfigManagerStub(normalizeCloudVmConfig({
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
    }), remoteDaemonConfig));

    vi.spyOn(managerAccess(manager), 'fetchVmStatus').mockResolvedValue('running');
    vi.spyOn(managerAccess(manager), 'checkTunnelHealth').mockResolvedValue(true);

    const state = await manager.getState();

    expect(state).toMatchObject({
      status: 'running',
      provider: 'gcp',
      serverId: 'pane-user123',
      tunnelStatus: 'running',
      daemonStatus: 'ready',
      daemonBaseUrl: 'http://127.0.0.1:42137',
      linkedRemoteProfileId: 'remote-profile-1',
      linkedRemoteProfileLabel: 'Pane Cloud Workspace',
      remoteConnectionStatus: 'available',
      preferredAccess: 'daemon',
      allowNoVncFallback: false,
      error: null,
    });
    expect(state.noVncUrl).toContain('http://localhost:8080/novnc/vnc.html');
  });

  it('surfaces daemon-backed hosted workspace state without requiring a local cloud API token', async () => {
    const remoteDaemonConfig = createDefaultRemoteDaemonConfig();
    remoteDaemonConfig.client.profiles = [{
      id: 'remote-profile-1',
      label: 'Pane Cloud Workspace',
      baseUrl: 'https://pane.example.com/daemon/',
      token: 'secret-token',
      transport: 'http+sse',
    }];
    vi.spyOn(remotePaneClientController, 'getConnectionState').mockReturnValue({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });

    const manager = createManager(new ConfigManagerStub(normalizeCloudVmConfig({
      provider: 'gcp',
      serverId: 'pane-user123',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
    }), remoteDaemonConfig));

    const fetchVmStatusSpy = vi.spyOn(managerAccess(manager), 'fetchVmStatus');

    const state = await manager.getState();

    expect(fetchVmStatusSpy).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      status: 'running',
      provider: 'gcp',
      serverId: 'pane-user123',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
      linkedRemoteProfileLabel: 'Pane Cloud Workspace',
      remoteConnectionStatus: 'available',
      preferredAccess: 'daemon',
      allowNoVncFallback: true,
      noVncUrl: null,
      tunnelStatus: 'off',
      error: null,
    });
  });

  it('surfaces daemon-backed hosted workspace state when lifecycle fields are incomplete', async () => {
    const manager = createManager(new ConfigManagerStub(normalizeCloudVmConfig({
      provider: 'gcp',
      apiToken: 'stale-token',
      serverId: 'pane-user123',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
    })));

    const fetchVmStatusSpy = vi.spyOn(managerAccess(manager), 'fetchVmStatus');

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
    const manager = createManager(new ConfigManagerStub(normalizeCloudVmConfig({
      provider: 'gcp',
      apiToken: 'stale-token',
      serverId: 'pane-user123',
      projectId: 'pane-project',
      zone: 'us-central1-a',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
    })));

    vi.spyOn(managerAccess(manager), 'fetchVmStatus').mockRejectedValue(new Error('401 Unauthorized'));

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

  it('connects the hosted workspace through the linked remote profile and syncs its endpoint', async () => {
    const remoteDaemonConfig = createDefaultRemoteDaemonConfig();
    remoteDaemonConfig.client.profiles = [{
      id: 'remote-profile-1',
      label: 'Pane Cloud Workspace',
      baseUrl: 'https://old.example.com/pane/',
      token: 'secret-token',
      transport: 'http+sse',
    }];
    vi.spyOn(remotePaneClientController, 'activateProfile').mockResolvedValue({
      mode: 'remote',
      status: 'connected',
      activeProfileId: 'remote-profile-1',
      activeProfileLabel: 'Pane Cloud Workspace',
      activeBaseUrl: 'https://pane.example.com/daemon/',
      lastError: null,
    });
    vi.spyOn(remotePaneClientController, 'getConnectionState').mockReturnValue({
      mode: 'remote',
      status: 'connected',
      activeProfileId: 'remote-profile-1',
      activeProfileLabel: 'Pane Cloud Workspace',
      activeBaseUrl: 'https://pane.example.com/daemon/',
      lastError: null,
    });

    const configManager = new ConfigManagerStub(normalizeCloudVmConfig({
      provider: 'gcp',
      apiToken: 'secret-token',
      serverId: 'pane-user123',
      projectId: 'pane-project',
      zone: 'us-central1-a',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
    }), remoteDaemonConfig);
    const manager = createManager(configManager);
    vi.spyOn(managerAccess(manager), 'fetchVmStatus').mockResolvedValue('running');
    vi.spyOn(managerAccess(manager), 'checkTunnelHealth').mockResolvedValue(true);

    const state = await manager.connectWorkspace();

    expect(remotePaneClientController.activateProfile).toHaveBeenCalledWith({
      id: 'remote-profile-1',
      label: 'Pane Cloud Workspace',
      baseUrl: 'https://pane.example.com/daemon/',
      token: 'secret-token',
      transport: 'http+sse',
    });
    expect(configManager.getConfig().remoteDaemon?.client).toMatchObject({
      activeProfileId: 'remote-profile-1',
      mode: 'remote',
    });
    expect(configManager.getConfig().remoteDaemon?.client.profiles).toContainEqual({
      id: 'remote-profile-1',
      label: 'Pane Cloud Workspace',
      baseUrl: 'https://pane.example.com/daemon/',
      token: 'secret-token',
      transport: 'http+sse',
    });
    expect(state).toMatchObject({
      linkedRemoteProfileId: 'remote-profile-1',
      linkedRemoteProfileLabel: 'Pane Cloud Workspace',
      remoteConnectionStatus: 'connected',
    });
  });

  it('requires the active hosted remote profile to match the current daemon endpoint', async () => {
    const remoteDaemonConfig = createDefaultRemoteDaemonConfig();
    remoteDaemonConfig.client.profiles = [{
      id: 'remote-profile-1',
      label: 'Pane Cloud Workspace',
      baseUrl: 'https://old.example.com/daemon/',
      token: 'secret-token',
      transport: 'http+sse',
    }];
    remoteDaemonConfig.client.activeProfileId = 'remote-profile-1';
    remoteDaemonConfig.client.mode = 'remote';

    vi.spyOn(remotePaneClientController, 'getConnectionState').mockReturnValue({
      mode: 'remote',
      status: 'connected',
      activeProfileId: 'remote-profile-1',
      activeProfileLabel: 'Pane Cloud Workspace',
      activeBaseUrl: 'https://old.example.com/daemon/',
      lastError: null,
    });

    const manager = createManager(new ConfigManagerStub(normalizeCloudVmConfig({
      provider: 'gcp',
      serverId: 'pane-user123',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://new.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
    }), remoteDaemonConfig));

    const state = await manager.getState();

    expect(state).toMatchObject({
      daemonBaseUrl: 'https://new.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
      linkedRemoteProfileLabel: 'Pane Cloud Workspace',
      remoteConnectionStatus: 'available',
    });
  });

  it('reports an error when a hosted workspace linked remote profile is missing', async () => {
    const remoteDaemonConfig = createDefaultRemoteDaemonConfig();
    remoteDaemonConfig.client.profiles = [];
    vi.spyOn(remotePaneClientController, 'getConnectionState').mockReturnValue({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });

    const manager = createManager(new ConfigManagerStub(normalizeCloudVmConfig({
      provider: 'gcp',
      serverId: 'pane-user123',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
    }), remoteDaemonConfig));

    const state = await manager.getState();

    expect(state).toMatchObject({
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
      linkedRemoteProfileLabel: null,
      remoteConnectionStatus: 'error',
    });
  });

  it('disconnects the hosted workspace when its linked remote profile is active', async () => {
    const remoteDaemonConfig = createDefaultRemoteDaemonConfig();
    remoteDaemonConfig.client.profiles = [{
      id: 'remote-profile-1',
      label: 'Pane Cloud Workspace',
      baseUrl: 'https://pane.example.com/daemon/',
      token: 'secret-token',
      transport: 'http+sse',
    }];
    remoteDaemonConfig.client.activeProfileId = 'remote-profile-1';
    remoteDaemonConfig.client.mode = 'remote';

    vi.spyOn(remotePaneClientController, 'switchToLocalMode').mockResolvedValue({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });
    vi.spyOn(remotePaneClientController, 'getConnectionState').mockReturnValue({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });

    const configManager = new ConfigManagerStub(normalizeCloudVmConfig({
      provider: 'gcp',
      apiToken: 'secret-token',
      serverId: 'pane-user123',
      projectId: 'pane-project',
      zone: 'us-central1-a',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
    }), remoteDaemonConfig);
    const manager = createManager(configManager);
    vi.spyOn(managerAccess(manager), 'fetchVmStatus').mockResolvedValue('running');
    vi.spyOn(managerAccess(manager), 'checkTunnelHealth').mockResolvedValue(true);

    const state = await manager.disconnectWorkspace();

    expect(remotePaneClientController.switchToLocalMode).toHaveBeenCalledOnce();
    expect(configManager.getConfig().remoteDaemon?.client).toMatchObject({
      activeProfileId: null,
      mode: 'local',
    });
    expect(state).toMatchObject({
      linkedRemoteProfileId: 'remote-profile-1',
      linkedRemoteProfileLabel: 'Pane Cloud Workspace',
      remoteConnectionStatus: 'available',
    });
  });

  it('switches back to local runtime before stopping a connected hosted workspace VM', async () => {
    const remoteDaemonConfig = createDefaultRemoteDaemonConfig();
    remoteDaemonConfig.client.profiles = [{
      id: 'remote-profile-1',
      label: 'Pane Cloud Workspace',
      baseUrl: 'https://pane.example.com/daemon/',
      token: 'secret-token',
      transport: 'http+sse',
    }];
    remoteDaemonConfig.client.activeProfileId = 'remote-profile-1';
    remoteDaemonConfig.client.mode = 'remote';

    vi.spyOn(remotePaneClientController, 'switchToLocalMode').mockResolvedValue({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });
    vi.spyOn(remotePaneClientController, 'getConnectionState').mockReturnValue({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });

    const configManager = new ConfigManagerStub(normalizeCloudVmConfig({
      provider: 'gcp',
      apiToken: 'secret-token',
      serverId: 'pane-user123',
      projectId: 'pane-project',
      zone: 'us-central1-a',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
    }), remoteDaemonConfig);
    const manager = createManager(configManager);
    vi.spyOn(managerAccess(manager), 'fetchVmStatus').mockResolvedValue('running');
    vi.spyOn(managerAccess(manager), 'checkTunnelHealth').mockResolvedValue(true);
    vi.spyOn(managerAccess(manager), 'gcpAction').mockResolvedValue(undefined);
    vi.spyOn(managerAccess(manager), 'waitForStatus').mockResolvedValue({
      ...createDefaultCloudVmState(),
      status: 'off',
    });

    await manager.stopVm();

    expect(remotePaneClientController.switchToLocalMode).toHaveBeenCalledOnce();
    expect(configManager.getConfig().remoteDaemon?.client).toMatchObject({
      activeProfileId: null,
      mode: 'local',
    });
  });

  it('does not stop the hosted VM when switching back to local runtime fails', async () => {
    const remoteDaemonConfig = createDefaultRemoteDaemonConfig();
    remoteDaemonConfig.client.profiles = [{
      id: 'remote-profile-1',
      label: 'Pane Cloud Workspace',
      baseUrl: 'https://pane.example.com/daemon/',
      token: 'secret-token',
      transport: 'http+sse',
    }];
    remoteDaemonConfig.client.activeProfileId = 'remote-profile-1';
    remoteDaemonConfig.client.mode = 'remote';

    vi.spyOn(remotePaneClientController, 'switchToLocalMode')
      .mockRejectedValue(new Error('config write failed'));
    vi.spyOn(remotePaneClientController, 'getConnectionState').mockReturnValue({
      mode: 'remote',
      status: 'connected',
      activeProfileId: 'remote-profile-1',
      activeProfileLabel: 'Pane Cloud Workspace',
      activeBaseUrl: 'https://pane.example.com/daemon/',
      lastError: null,
    });

    const configManager = new ConfigManagerStub(normalizeCloudVmConfig({
      provider: 'gcp',
      apiToken: 'secret-token',
      serverId: 'pane-user123',
      projectId: 'pane-project',
      zone: 'us-central1-a',
      daemonStatus: 'ready',
      daemonBaseUrl: 'https://pane.example.com/daemon/',
      linkedRemoteProfileId: 'remote-profile-1',
    }), remoteDaemonConfig);
    const manager = createManager(configManager);
    const gcpAction = vi.spyOn(managerAccess(manager), 'gcpAction').mockResolvedValue(undefined);

    await expect(manager.stopVm()).rejects.toThrow('config write failed');

    expect(gcpAction).not.toHaveBeenCalled();
    expect(configManager.getConfig().remoteDaemon?.client).toMatchObject({
      activeProfileId: 'remote-profile-1',
      mode: 'remote',
    });
  });
});
