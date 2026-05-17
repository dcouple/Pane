import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import https from 'https';
import http from 'http';
import type { ConfigManager } from './configManager';
import type { Logger } from '../utils/logger';
import {
  type CloudRemoteConnectionStatus,
  createDefaultCloudVmState,
  type CloudProvider,
  type CloudDaemonStatus,
  type CloudVmConfig,
  type CloudVmState,
  type TunnelStatus,
  type VmStatus,
} from '../../../shared/types/cloud';
import {
  createDefaultRemoteDaemonConfig,
  normalizeRemoteDaemonConfig,
  type RemoteDaemonConfig,
  type RemotePaneConnectionProfile,
} from '../../../shared/types/remoteDaemon';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';

export type { CloudProvider, VmStatus, TunnelStatus, CloudVmConfig, CloudVmState };

/**
 * Manages cloud VM lifecycle (start/stop/status) for Pane Cloud.
 * Uses GCP Compute Engine with IAP-only access (no public IP).
 */
export class CloudVmManager extends EventEmitter {
  private pollInterval: ReturnType<typeof setTimeout> | null = null;
  private tunnelProcess: ChildProcess | null = null;
  private tunnelStatus: TunnelStatus = 'off';
  private cachedState: CloudVmState = createDefaultCloudVmState();
  private operationInProgress = false;
  private isRefreshingToken = false;
  private consecutiveErrors = 0;
  private pollingStopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private configManager: ConfigManager,
    private logger?: Logger
  ) {
    super();

    // Listen for config changes and immediately refresh state
    this.configManager.on('config-updated', async () => {
      if (this.isRefreshingToken) return;
      this.logger?.info('[CloudVM] Config updated, refreshing state...');
      try {
        const state = await this.getState();
        this.emit('state-changed', state);
      } catch (err) {
        this.logger?.error('[CloudVM] Error refreshing state after config update', err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ============================================================
  // Public API
  // ============================================================

  /**
   * Get the current cloud VM state
   */
  async getState(): Promise<CloudVmState> {
    const config = this.getCloudStateConfig();
    if (!config) {
      this.cachedState = createDefaultCloudVmState();
      return { ...this.cachedState };
    }

    if (!this.canManageVmLifecycle(config)) {
      if (!this.hasDaemonHostedWorkspaceState(config)) {
        this.cachedState = createDefaultCloudVmState();
        return { ...this.cachedState };
      }

      this.cachedState = {
        status: this.mapDaemonStatusToVmStatus(config.daemonStatus ?? 'unknown'),
        ip: null,
        noVncUrl: null,
        ...this.getHostedWorkspaceStateFromConfig(config),
        lastChecked: new Date().toISOString(),
        error: null,
        tunnelStatus: 'off',
      };
      return { ...this.cachedState };
    }

    try {
      const status = await this.fetchVmStatus(config);
      const tunnelPort = config.tunnelPort || 8080;

      // Determine effective tunnel status:
      // - If we have a managed tunnel process, use this.tunnelStatus
      // - Otherwise, perform actual health check if VM is running
      let effectiveTunnelStatus = this.tunnelStatus;
      if (!this.tunnelProcess && status === 'running') {
        try {
          const isLive = await this.checkTunnelHealth(tunnelPort);
          effectiveTunnelStatus = isLive ? 'running' : 'off';
        } catch {
          effectiveTunnelStatus = 'off';
        }
      }

      this.cachedState = {
        status,
        ip: null,
        noVncUrl: this.buildNoVncUrl(tunnelPort, config.vncPassword),
        ...this.getHostedWorkspaceStateFromConfig(config),
        lastChecked: new Date().toISOString(),
        error: null,
        tunnelStatus: effectiveTunnelStatus,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(`[CloudVM] Failed to fetch status: ${message}`);

      if (this.hasDaemonHostedWorkspaceState(config)) {
        this.cachedState = {
          status: this.mapDaemonStatusToVmStatus(config.daemonStatus ?? 'unknown'),
          ip: null,
          noVncUrl: null,
          ...this.getHostedWorkspaceStateFromConfig(config),
          lastChecked: new Date().toISOString(),
          error: null,
          tunnelStatus: this.tunnelStatus,
        };
        return { ...this.cachedState };
      }

      this.cachedState.error = message;
      this.cachedState.status = 'unknown';
    }

    return { ...this.cachedState };
  }

  /**
   * Start the cloud VM (spin up)
   */
  async startVm(): Promise<CloudVmState> {
    if (this.operationInProgress) {
      this.logger?.warn('[CloudVM] startVm skipped — another operation is already in progress');
      return { ...this.cachedState };
    }
    this.operationInProgress = true;
    try {
      const config = this.getCloudConfig();
      if (!config) {
        throw new Error('Cloud VM not configured. Set cloud settings in Pane Settings.');
      }
      if (!config.serverId) {
        throw new Error('No server ID configured. Provision a VM first using Terraform.');
      }

      this.logger?.info(`[CloudVM] Starting VM ${config.serverId} on ${config.provider}`);
      this.cachedState.status = 'starting';
      this.emit('state-changed', { ...this.cachedState });

      try {
        await this.gcpAction(config, 'start');

        // Poll until running (max 60 seconds)
        const state = await this.waitForStatus(config, 'running', 60_000);
        this.emit('state-changed', state);

        // Auto-start IAP tunnel once VM is running
        try {
          await this.startTunnel(config);
        } catch (tunnelErr) {
          const tunnelMsg = tunnelErr instanceof Error ? tunnelErr.message : String(tunnelErr);
          this.logger?.error(`[CloudVM] Tunnel failed after VM start: ${tunnelMsg}`);
          state.tunnelStatus = 'error';
          state.error = `VM running but tunnel failed: ${tunnelMsg}`;
          this.cachedState = { ...state };
          this.emit('state-changed', { ...this.cachedState });
        }

        return { ...this.cachedState };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.cachedState.error = message;
        this.cachedState.status = 'unknown';
        this.emit('state-changed', { ...this.cachedState });
        throw err;
      }
    } finally {
      this.operationInProgress = false;
    }
  }

  /**
   * Stop the cloud VM (spin down — disk persists)
   */
  async stopVm(): Promise<CloudVmState> {
    if (this.operationInProgress) {
      this.logger?.warn('[CloudVM] stopVm skipped — another operation is already in progress');
      return { ...this.cachedState };
    }
    this.operationInProgress = true;
    try {
      const config = this.getCloudConfig();
      if (!config || !config.serverId) {
        throw new Error('Cloud VM not configured or no server ID.');
      }

      this.logger?.info(`[CloudVM] Stopping VM ${config.serverId} on ${config.provider}`);

      // Stop tunnel before stopping VM
      this.stopTunnel();

      this.cachedState.status = 'stopping';
      this.emit('state-changed', { ...this.cachedState });

      try {
        await this.gcpAction(config, 'stop');

        const state = await this.waitForStatus(config, 'off', 60_000);
        this.emit('state-changed', state);
        return state;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.cachedState.error = message;
        this.cachedState.status = 'unknown';
        this.emit('state-changed', { ...this.cachedState });
        throw err;
      }
    } finally {
      this.operationInProgress = false;
    }
  }

  async connectWorkspace(): Promise<CloudVmState> {
    const cloudConfig = this.getCloudStateConfig();
    if (!cloudConfig) {
      throw new Error('Hosted cloud workspace is not configured');
    }

    if (!cloudConfig.linkedRemoteProfileId) {
      throw new Error('Hosted cloud workspace does not have a linked remote profile');
    }

    const remoteConfig = this.getRemoteDaemonConfig();
    const profile = remoteConfig.client.profiles.find((candidate) => candidate.id === cloudConfig.linkedRemoteProfileId);
    if (!profile) {
      throw new Error(`Hosted cloud workspace linked profile "${cloudConfig.linkedRemoteProfileId}" does not exist`);
    }

    const nextProfile = cloudConfig.daemonBaseUrl && profile.baseUrl !== cloudConfig.daemonBaseUrl
      ? { ...profile, baseUrl: cloudConfig.daemonBaseUrl }
      : profile;

    const nextRemoteConfig = normalizeRemoteDaemonConfig({
      ...remoteConfig,
      client: {
        ...remoteConfig.client,
        profiles: upsertById(remoteConfig.client.profiles, nextProfile),
        activeProfileId: nextProfile.id,
        mode: 'remote',
      },
    });

    await remotePaneClientController.activateProfile(nextProfile);
    await this.configManager.updateConfig({ remoteDaemon: nextRemoteConfig });

    const state = await this.getState();
    this.emit('state-changed', state);
    return state;
  }

  async disconnectWorkspace(): Promise<CloudVmState> {
    const cloudConfig = this.getCloudStateConfig();
    if (!cloudConfig?.linkedRemoteProfileId) {
      const state = await this.getState();
      this.emit('state-changed', state);
      return state;
    }

    const remoteConfig = this.getRemoteDaemonConfig();
    const linkedProfileIsActive =
      remoteConfig.client.mode === 'remote' &&
      remoteConfig.client.activeProfileId === cloudConfig.linkedRemoteProfileId;

    if (!linkedProfileIsActive) {
      const state = await this.getState();
      this.emit('state-changed', state);
      return state;
    }

    const nextRemoteConfig = normalizeRemoteDaemonConfig({
      ...remoteConfig,
      client: {
        ...remoteConfig.client,
        activeProfileId: null,
        mode: 'local',
      },
    });

    await remotePaneClientController.switchToLocalMode();
    await this.configManager.updateConfig({ remoteDaemon: nextRemoteConfig });

    const state = await this.getState();
    this.emit('state-changed', state);
    return state;
  }

  /**
   * Start polling VM status at an interval
   */
  startPolling(intervalMs: number = 30_000): void {
    this.logger?.info(`[CloudVM] Starting status polling (interval: ${intervalMs}ms)`);
    this.stopPolling();
    this.pollingStopped = false;
    const poll = async () => {
      if (this.pollingStopped) return;
      try {
        const state = await this.getState();
        this.emit('state-changed', state);
        this.consecutiveErrors = 0;
      } catch (err) {
        this.consecutiveErrors++;
        this.logger?.error(`[CloudVM] Polling error (${this.consecutiveErrors} consecutive):`, err instanceof Error ? err : new Error(String(err)));
      }
      if (this.pollingStopped) return;
      const backoff = Math.min(intervalMs * Math.pow(2, this.consecutiveErrors), 300_000);
      this.pollInterval = setTimeout(poll, this.consecutiveErrors > 0 ? backoff : intervalMs);
    };
    this.pollInterval = setTimeout(poll, intervalMs);
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    this.logger?.info('[CloudVM] Stopping status polling');
    this.pollingStopped = true;
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
  }

  // ============================================================
  // IAP Tunnel Management
  // ============================================================

  /**
   * Start an IAP tunnel to the VM.
   * Spawns `gcloud compute start-iap-tunnel` as a background child process.
   */
  async startTunnel(config?: CloudVmConfig): Promise<void> {
    const cfg = config || this.getCloudConfig();
    if (!cfg || !cfg.serverId || !cfg.zone || !cfg.projectId) {
      const error = 'Cloud config missing required fields for tunnel (serverId, zone, projectId).';
      this.logger?.error(`[CloudVM] ${error}`);
      throw new Error(error);
    }

    // Don't start if already running
    if (this.tunnelProcess && this.tunnelStatus === 'running') {
      this.logger?.info('[CloudVM] Tunnel already running, skipping start.');
      return;
    }

    // Kill any stale process first
    this.stopTunnel();

    const port = cfg.tunnelPort || 8080;
    this.tunnelStatus = 'starting';
    this.cachedState.tunnelStatus = 'starting';
    this.emit('state-changed', { ...this.cachedState });

    this.logger?.info(`[CloudVM] Starting IAP tunnel: ${cfg.serverId} port 80 → localhost:${port}`);

    return new Promise<void>((resolve, reject) => {
      const proc = spawn('gcloud', [
        'compute', 'start-iap-tunnel',
        cfg.serverId!,
        '80',
        `--local-host-port=localhost:${port}`,
        `--zone=${cfg.zone}`,
        `--project=${cfg.projectId}`,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.tunnelProcess = proc;
      let resolved = false;

      // gcloud prints "Listening on port [XXXX]." to stderr when ready
      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        this.logger?.info(`[CloudVM] Tunnel stderr: ${text.trim()}`);

        if (!resolved && text.includes('Listening on port')) {
          resolved = true;
          this.tunnelStatus = 'running';
          this.cachedState.tunnelStatus = 'running';
          this.emit('state-changed', { ...this.cachedState });
          this.logger?.info('[CloudVM] IAP tunnel is ready.');

          // Wait for tunnel to be usable, then resolve
          this.waitForTunnel(port, 30_000).then(() => {
            resolve();
          }).catch((err) => {
            this.logger?.warn(`[CloudVM] Tunnel health check failed, but tunnel may still work: ${err instanceof Error ? err.message : String(err)}`);
            resolve(); // Resolve anyway — the tunnel process is running
          });
        }
      });

      proc.stdout?.on('data', (data: Buffer) => {
        this.logger?.info(`[CloudVM] Tunnel stdout: ${data.toString().trim()}`);
      });

      proc.on('error', (err) => {
        // Guard against stale process events
        if (this.tunnelProcess !== proc) {
          if (!resolved) { resolved = true; reject(err); }
          return;
        }
        this.tunnelStatus = 'error';
        this.cachedState.tunnelStatus = 'error';
        this.tunnelProcess = null;
        this.emit('state-changed', { ...this.cachedState });
        if (!resolved) {
          resolved = true;
          reject(new Error(`Tunnel process error: ${err.message}`));
        }
      });

      proc.on('close', (code) => {
        this.logger?.info(`[CloudVM] Tunnel process exited with code ${code}`);

        // Guard: only update state if this is still the active tunnel process.
        // A stale process (killed by stopTunnel before a new one started) may
        // fire 'close' after the new process is already assigned.
        if (this.tunnelProcess !== proc) {
          this.logger?.info('[CloudVM] Ignoring close from stale tunnel process.');
          if (!resolved) {
            resolved = true;
            reject(new Error(`Tunnel exited with code ${code} before becoming ready`));
          }
          return;
        }

        const wasRunning = this.tunnelStatus === 'running';
        this.tunnelStatus = 'off';
        this.cachedState.tunnelStatus = 'off';
        this.tunnelProcess = null;
        this.emit('state-changed', { ...this.cachedState });

        if (!resolved) {
          resolved = true;
          reject(new Error(`Tunnel exited with code ${code} before becoming ready`));
        } else if (wasRunning) {
          this.logger?.warn('[CloudVM] Tunnel process died unexpectedly. Attempting auto-reconnect in 3s...');
          this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
              await this.startTunnel();
              this.logger?.info('[CloudVM] Auto-reconnect succeeded.');
            } catch (err) {
              this.logger?.error('[CloudVM] Auto-reconnect failed:', err instanceof Error ? err : new Error(String(err)));
            }
          }, 3000);
        }
      });

      // Timeout: if tunnel doesn't become ready within 30s, fail
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.logger?.error('[CloudVM] Tunnel start timed out after 30s');
          this.tunnelStatus = 'error';
          this.cachedState.tunnelStatus = 'error';
          this.emit('state-changed', { ...this.cachedState });
          reject(new Error('Tunnel did not become ready within 30 seconds'));
        }
      }, 30_000);
    });
  }

  /**
   * Stop the IAP tunnel child process.
   */
  stopTunnel(): void {
    // Cancel any pending auto-reconnect timer so it doesn't fire after
    // an intentional stop (e.g., user stops the VM or app is quitting)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.tunnelProcess) {
      this.logger?.info('[CloudVM] Stopping IAP tunnel...');
      try {
        this.tunnelProcess.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
      this.tunnelProcess = null;
    }
    this.tunnelStatus = 'off';
    this.cachedState.tunnelStatus = 'off';
  }

  /**
   * Check if the tunnel is currently running.
   */
  isTunnelRunning(): boolean {
    return this.tunnelStatus === 'running' && this.tunnelProcess !== null;
  }

  /**
   * Poll localhost until the tunnel is usable (nginx responds with HTTP 200).
   */
  private async waitForTunnel(port: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    const pollIntervalMs = 2000;

    while (Date.now() - start < timeoutMs) {
      try {
        const ok = await this.checkTunnelHealth(port);
        if (ok) {
          this.logger?.info('[CloudVM] Tunnel health check passed.');
          return;
        }
      } catch {
        // Expected while tunnel is warming up
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Tunnel health check did not pass within ${timeoutMs / 1000}s`);
  }

  /**
   * Make a single HTTP request to localhost to check if tunnel is forwarding.
   */
  private checkTunnelHealth(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        { hostname: 'localhost', port, path: '/', method: 'GET', timeout: 3000 },
        (res) => {
          // Any response means the tunnel is forwarding
          res.resume(); // Drain response
          resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  // ============================================================
  // GCP Token Refresh
  // ============================================================

  /**
   * Refresh the GCP access token via `gcloud auth print-access-token`.
   * Updates the stored config if the token changed.
   */
  private async refreshGcpToken(): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('gcloud', ['auth', 'print-access-token']);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          const newToken = stdout.trim();
          // Update config if token changed
          const appConfig = this.configManager.getConfig();
          if (appConfig.cloud && appConfig.cloud.apiToken !== newToken) {
            this.isRefreshingToken = true;
            try {
              appConfig.cloud.apiToken = newToken;
              this.configManager.updateConfig({ cloud: appConfig.cloud });
              this.logger?.info('[CloudVM] GCP token refreshed and saved to config.');
            } finally {
              this.isRefreshingToken = false;
            }
          }
          resolve(newToken);
        } else {
          const error = new Error(`Failed to refresh GCP token (code ${code}): ${stderr.trim()}`);
          this.logger?.error(`[CloudVM] ${error.message}`);
          reject(error);
        }
      });
      proc.on('error', (err) => {
        const error = new Error(`gcloud not found: ${err.message}`);
        this.logger?.error(`[CloudVM] ${error.message}`);
        reject(error);
      });
    });
  }

  // ============================================================
  // GCP Compute Engine API
  // ============================================================

  private async gcpAction(config: CloudVmConfig, action: 'start' | 'stop'): Promise<void> {
    if (!config.projectId || !config.zone || !config.serverId) {
      const error = 'Cloud config incomplete: projectId, zone, and serverId are all required.';
      this.logger?.error(`[CloudVM] gcpAction(${action}): ${error}`);
      throw new Error(error);
    }
    // Refresh token before API call, fall back to stored token if gcloud fails
    let token: string;
    try {
      token = await this.refreshGcpToken();
    } catch (err) {
      if (config.apiToken) {
        this.logger?.warn(`[CloudVM] gcpAction(${action}): gcloud token refresh failed, using stored token`);
        token = config.apiToken;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        const error = `GCP authentication failed (re-run cloud setup to re-authenticate): ${msg}`;
        this.logger?.error(`[CloudVM] gcpAction(${action}): ${error}`);
        throw new Error(error);
      }
    }
    this.logger?.info(`[CloudVM] GCP API: POST ${action} for ${config.serverId}`);
    const url = `https://compute.googleapis.com/compute/v1/projects/${config.projectId}/zones/${config.zone}/instances/${config.serverId}/${action}`;
    await this.httpRequest('POST', url, token);
  }

  private async gcpGetStatus(config: CloudVmConfig): Promise<VmStatus> {
    if (!config.projectId || !config.zone || !config.serverId) {
      const error = 'Cloud config incomplete: projectId, zone, and serverId are all required.';
      this.logger?.error(`[CloudVM] gcpGetStatus: ${error}`);
      throw new Error(error);
    }
    // Refresh token before API call, fall back to stored token if gcloud fails
    let token: string;
    try {
      token = await this.refreshGcpToken();
    } catch (err) {
      if (config.apiToken) {
        this.logger?.warn('[CloudVM] gcpGetStatus: gcloud token refresh failed, using stored token');
        token = config.apiToken;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        const error = `GCP authentication failed (re-run cloud setup to re-authenticate): ${msg}`;
        this.logger?.error(`[CloudVM] gcpGetStatus: ${error}`);
        throw new Error(error);
      }
    }
    const url = `https://compute.googleapis.com/compute/v1/projects/${config.projectId}/zones/${config.zone}/instances/${config.serverId}`;
    const data = await this.httpRequest('GET', url, token);
    const parsed = JSON.parse(data);
    const gcpStatus = parsed?.status;

    switch (gcpStatus) {
      case 'RUNNING': return 'running';
      case 'TERMINATED':
      case 'STOPPED': return 'off';
      case 'STAGING':
      case 'PROVISIONING': return 'starting';
      case 'STOPPING':
      case 'SUSPENDING': return 'stopping';
      default: return 'unknown';
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  private getCloudConfig(): CloudVmConfig | null {
    const config = this.configManager.getConfig();
    if (!config.cloud?.provider || !config.cloud?.apiToken) {
      return null;
    }
    return config.cloud;
  }

  private getCloudStateConfig(): CloudVmConfig | null {
    const config = this.configManager.getConfig();
    if (!config.cloud?.provider) {
      return null;
    }

    return config.cloud;
  }

  private canManageVmLifecycle(config: CloudVmConfig): boolean {
    return Boolean(
      config.apiToken.trim().length > 0
      && config.serverId
      && config.projectId
      && config.zone,
    );
  }

  private getRemoteDaemonConfig(): RemoteDaemonConfig {
    return normalizeRemoteDaemonConfig(this.configManager.getConfig().remoteDaemon ?? createDefaultRemoteDaemonConfig());
  }

  private hasDaemonHostedWorkspaceState(config: CloudVmConfig): boolean {
    return Boolean(
      config.serverId
      || config.daemonBaseUrl
      || config.linkedRemoteProfileId
      || (config.daemonStatus && config.daemonStatus !== 'unknown'),
    );
  }

  private getHostedWorkspaceStateFromConfig(config: CloudVmConfig): {
    provider: CloudProvider;
    serverId: string | null;
    daemonStatus: CloudDaemonStatus;
    daemonBaseUrl: string | null;
    linkedRemoteProfileId: string | null;
    linkedRemoteProfileLabel: string | null;
    remoteConnectionStatus: CloudRemoteConnectionStatus;
    preferredAccess: CloudVmState['preferredAccess'];
    allowNoVncFallback: boolean;
  } {
    const remoteConfig = this.getRemoteDaemonConfig();
    const linkedProfile = this.getLinkedRemoteProfile(config, remoteConfig);

    return {
      provider: config.provider,
      serverId: config.serverId ?? null,
      daemonStatus: config.daemonStatus ?? 'unknown',
      daemonBaseUrl: config.daemonBaseUrl ?? null,
      linkedRemoteProfileId: config.linkedRemoteProfileId ?? null,
      linkedRemoteProfileLabel: linkedProfile?.label ?? null,
      remoteConnectionStatus: this.getHostedWorkspaceRemoteConnectionStatus(config, linkedProfile),
      preferredAccess: config.preferredAccess ?? 'daemon',
      allowNoVncFallback: config.allowNoVncFallback ?? true,
    };
  }

  private getLinkedRemoteProfile(
    config: CloudVmConfig,
    remoteConfig: RemoteDaemonConfig,
  ): RemotePaneConnectionProfile | null {
    if (!config.linkedRemoteProfileId) {
      return null;
    }

    return remoteConfig.client.profiles.find((profile) => profile.id === config.linkedRemoteProfileId) ?? null;
  }

  private getHostedWorkspaceRemoteConnectionStatus(
    config: CloudVmConfig,
    linkedProfile: RemotePaneConnectionProfile | null,
  ): CloudRemoteConnectionStatus {
    if (!config.linkedRemoteProfileId) {
      return 'unlinked';
    }

    if (!linkedProfile) {
      return 'error';
    }

    const connectionState = remotePaneClientController.getConnectionState();
    const expectedBaseUrl = config.daemonBaseUrl ?? linkedProfile.baseUrl;
    if (
      connectionState.mode === 'remote' &&
      connectionState.activeProfileId === linkedProfile.id &&
      connectionState.activeBaseUrl === expectedBaseUrl
    ) {
      return connectionState.status;
    }

    return 'available';
  }

  private mapDaemonStatusToVmStatus(daemonStatus: CloudDaemonStatus): VmStatus {
    switch (daemonStatus) {
      case 'ready':
        return 'running';
      case 'bootstrapping':
        return 'initializing';
      case 'error':
      case 'unknown':
      default:
        return 'unknown';
    }
  }

  /**
   * Build noVNC URL with password pre-filled if available
   */
  private buildNoVncUrl(tunnelPort: number, vncPassword?: string): string {
    const baseUrl = `http://localhost:${tunnelPort}/novnc/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=1000`;
    if (vncPassword) {
      return `${baseUrl}&password=${encodeURIComponent(vncPassword)}`;
    }
    return baseUrl;
  }

  private async fetchVmStatus(config: CloudVmConfig): Promise<VmStatus> {
    return this.gcpGetStatus(config);
  }

  private async waitForStatus(
    config: CloudVmConfig,
    targetStatus: VmStatus,
    timeoutMs: number
  ): Promise<CloudVmState> {
    const start = Date.now();
    const pollIntervalMs = 3000;

    while (Date.now() - start < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      const status = await this.fetchVmStatus(config);

      const tunnelPort = config.tunnelPort || 8080;
      this.cachedState = {
        status,
        ip: null,
        noVncUrl: status === 'running'
          ? this.buildNoVncUrl(tunnelPort, config.vncPassword)
          : null,
        ...this.getHostedWorkspaceStateFromConfig(config),
        lastChecked: new Date().toISOString(),
        error: null,
        tunnelStatus: this.tunnelStatus,
      };

      if (status === targetStatus) {
        return { ...this.cachedState };
      }
    }

    const error = `VM did not reach '${targetStatus}' within ${timeoutMs / 1000}s (current: ${this.cachedState.status})`;
    this.logger?.error(`[CloudVM] ${error}`);
    throw new Error(error);
  }

  private httpRequest(method: string, url: string, token: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        timeout: 15_000,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            const error = `HTTP ${res.statusCode}: ${data.substring(0, 500)}`;
            this.logger?.error(`[CloudVM] GCP API error: ${error}`);
            reject(new Error(error));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        this.logger?.error('[CloudVM] GCP API request timed out after 15s');
        reject(new Error('GCP API request timed out after 15s'));
      });
      req.end();
    });
  }
}

function upsertById<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);
  if (existingIndex === -1) {
    return [...items, nextItem];
  }

  return items.map((item, index) => (index === existingIndex ? nextItem : item));
}
