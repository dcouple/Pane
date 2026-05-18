import type { PaneEventSink } from '../core/eventSink';
import type { ConfigManager } from '../services/configManager';
import { getRemoteDaemonHostConfigValidationError } from '../../../shared/types/remoteDaemon';
import type { RemoteDaemonHostConfig } from '../../../shared/types/remoteDaemon';
import type { PaneCommandRegistry } from './commandRegistry';
import { PaneRemoteHttpApiServer } from './httpApiServer';
import { remoteHostRuntimeStateStore } from './remoteHostRuntimeState';

let activeRemoteHttpApiServer: PaneRemoteHttpApiServer | null = null;

export function disconnectActiveRemoteHostClients(clientIds?: string[]): number {
  return activeRemoteHttpApiServer?.disconnectClients(clientIds) ?? 0;
}

export class PaneRemoteTransportController {
  private remoteHttpApiServer: PaneRemoteHttpApiServer | null = null;
  private activeBindingKey: string | null = null;
  private syncQueue: Promise<void> = Promise.resolve();
  private configListenerAttached = false;

  private readonly configUpdatedListener = () => {
    void this.syncToConfig().catch((error) => {
      console.error('[Pane remote daemon] Failed to apply remote transport config update', error);
    });
  };

  private readonly eventSink: PaneEventSink = {
    send: (channel, ...args) => {
      this.remoteHttpApiServer?.getEventSink().send(channel, ...args);
    },
  };

  constructor(
    private readonly commandRegistry: PaneCommandRegistry,
    private readonly configManager: ConfigManager,
  ) {}

  getEventSink(): PaneEventSink {
    return this.eventSink;
  }

  getServer(): PaneRemoteHttpApiServer | null {
    return this.remoteHttpApiServer;
  }

  disconnectClients(clientIds?: string[]): number {
    return this.remoteHttpApiServer?.disconnectClients(clientIds) ?? 0;
  }

  startWatchingConfig(): void {
    if (this.configListenerAttached) {
      return;
    }

    this.configManager.on('config-updated', this.configUpdatedListener);
    this.configListenerAttached = true;
  }

  async stopWatchingAndShutdown(): Promise<void> {
    if (this.configListenerAttached) {
      this.configManager.off('config-updated', this.configUpdatedListener);
      this.configListenerAttached = false;
    }

    await this.enqueueSync(async () => {
      await this.stopRemoteHttpServer();
      remoteHostRuntimeStateStore.setInactive();
    });
  }

  async syncToConfig(): Promise<void> {
    await this.enqueueSync(async () => {
      const hostConfig = this.configManager.getConfig().remoteDaemon?.host.config;
      if (!hostConfig?.enabled) {
        await this.stopRemoteHttpServer();
        remoteHostRuntimeStateStore.setInactive(hostConfig);
        return;
      }

      const validationError = getRemoteDaemonHostConfigValidationError(hostConfig);
      if (validationError) {
        await this.stopRemoteHttpServer();
        remoteHostRuntimeStateStore.setError(hostConfig, new Error(validationError));
        throw new Error(validationError);
      }

      const nextBindingKey = this.getBindingKey(hostConfig);
      if (this.remoteHttpApiServer && this.activeBindingKey === nextBindingKey) {
        remoteHostRuntimeStateStore.setLive(hostConfig, this.remoteHttpApiServer.getAddress());
        return;
      }

      await this.stopRemoteHttpServer();

      const remoteHttpApiServer = new PaneRemoteHttpApiServer(this.commandRegistry, this.configManager);
      try {
        await remoteHttpApiServer.start();
        this.remoteHttpApiServer = remoteHttpApiServer;
        this.activeBindingKey = nextBindingKey;
        activeRemoteHttpApiServer = remoteHttpApiServer;
        remoteHostRuntimeStateStore.setLive(hostConfig, remoteHttpApiServer.getAddress());
      } catch (error) {
        await remoteHttpApiServer.stop();
        remoteHostRuntimeStateStore.setError(hostConfig, error);
        throw error;
      }
    });
  }

  private async stopRemoteHttpServer(): Promise<void> {
    const remoteHttpApiServer = this.remoteHttpApiServer;
    this.remoteHttpApiServer = null;
    this.activeBindingKey = null;

    if (remoteHttpApiServer) {
      await remoteHttpApiServer.stop();
    }

    if (activeRemoteHttpApiServer === remoteHttpApiServer) {
      activeRemoteHttpApiServer = null;
    }
  }

  private enqueueSync(work: () => Promise<void>): Promise<void> {
    const nextSync = this.syncQueue.then(work, work);
    this.syncQueue = nextSync.catch(() => {});
    return nextSync;
  }

  private getBindingKey(config: RemoteDaemonHostConfig): string {
    return JSON.stringify({
      listenHost: config.listenHost.trim().toLowerCase(),
      listenPort: config.listenPort,
      allowInsecureHttpOnLoopback: config.allowInsecureHttpOnLoopback,
    });
  }
}
