import { EventEmitter } from 'events';
import {
  createDefaultRemoteDaemonHostRuntimeState,
  type RemoteDaemonConnectedClient,
  type RemoteDaemonHostConfig,
  type RemoteDaemonHostRuntimeState,
} from '../../../shared/types/remoteDaemon';

interface RemoteHttpAddress {
  host: string;
  port: number;
}

class RemoteHostRuntimeStateStore extends EventEmitter {
  private state: RemoteDaemonHostRuntimeState = createDefaultRemoteDaemonHostRuntimeState();

  getState(): RemoteDaemonHostRuntimeState {
    return { ...this.state };
  }

  setInactive(config?: RemoteDaemonHostConfig | null): void {
    this.setState({
      enabled: config?.enabled === true,
      status: 'inactive',
      listenHost: config?.listenHost ?? null,
      listenPort: config?.listenPort ?? null,
      lastError: null,
      connectedClients: [],
      updatedAt: new Date().toISOString(),
    });
  }

  setLive(config: RemoteDaemonHostConfig, address?: RemoteHttpAddress | null): void {
    this.setState({
      enabled: true,
      status: 'live',
      listenHost: address?.host ?? config.listenHost,
      listenPort: address?.port ?? config.listenPort,
      lastError: null,
      connectedClients: this.state.status === 'live' ? this.state.connectedClients : [],
      updatedAt: new Date().toISOString(),
    });
  }

  setError(config: RemoteDaemonHostConfig | null | undefined, error: unknown): void {
    this.setState({
      enabled: config?.enabled === true,
      status: 'error',
      listenHost: config?.listenHost ?? null,
      listenPort: config?.listenPort ?? null,
      lastError: getErrorMessage(error, 'Remote listener failed'),
      connectedClients: [],
      updatedAt: new Date().toISOString(),
    });
  }

  setConnectedClients(connectedClients: RemoteDaemonConnectedClient[]): void {
    if (this.state.status !== 'live') {
      return;
    }

    this.setState({
      ...this.state,
      connectedClients,
      updatedAt: new Date().toISOString(),
    });
  }

  resetForTests(): void {
    this.setState(createDefaultRemoteDaemonHostRuntimeState());
  }

  private setState(state: RemoteDaemonHostRuntimeState): void {
    this.state = { ...state };
    this.emit('state-changed', this.getState());
  }
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }

  return fallback;
}

export const remoteHostRuntimeStateStore = new RemoteHostRuntimeStateStore();
