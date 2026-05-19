import type { ToolPanel } from '../../../../shared/types/panels';
import type { RemoteDaemonEventEnvelope, RemotePaneConnectionProfile, RemotePwaAffordances } from '../../../../shared/types/remoteDaemon';
import type { Project } from '../../types/project';
import type { Session, SessionOutput } from '../../types/session';
import { RemoteDaemonBrowserClient, type RemoteBrowserConnectionState } from './remoteDaemonBrowserClient';

export interface RemoteProjectWithSessions extends Project {
  sessions?: Session[];
}

interface IpcLikeResponse<T> {
  success?: boolean;
  data?: T;
  error?: string;
}

export type RemoteRuntimeEventListener = (event: RemoteDaemonEventEnvelope) => void;
export type RemoteRuntimeStatusListener = (status: RemoteBrowserConnectionState) => void;

export class RemoteRuntimeAdapter {
  private readonly client: RemoteDaemonBrowserClient;

  constructor(readonly profile: RemotePaneConnectionProfile) {
    this.client = new RemoteDaemonBrowserClient(profile);
  }

  connect(): Promise<void> {
    return this.client.connect();
  }

  disconnect(): void {
    this.client.disconnect();
  }

  getStatus(): RemoteBrowserConnectionState {
    return this.client.getState();
  }

  onStatus(listener: RemoteRuntimeStatusListener): () => void {
    return this.client.onStatus(listener);
  }

  onEvent(listener: RemoteRuntimeEventListener): () => void {
    return this.client.onEvent(event => {
      if (event.type === 'daemon-event') {
        listener(event.payload);
      }
    });
  }

  async invoke<T>(channel: string, args: unknown[] = []): Promise<T> {
    const response = await this.client.invoke<IpcLikeResponse<T> | T>(channel, args);
    if (isIpcResponse<T>(response)) {
      if (response.success === false) {
        throw new Error(response.error ?? `${channel} failed`);
      }
      return response.data as T;
    }
    return response as T;
  }

  getProjectsWithSessions(): Promise<RemoteProjectWithSessions[]> {
    return this.invoke<RemoteProjectWithSessions[]>('sessions:get-all-with-projects');
  }

  getSession(sessionId: string): Promise<Session> {
    return this.invoke<Session>('sessions:get', [sessionId]);
  }

  getPanels(sessionId: string): Promise<ToolPanel[]> {
    return this.invoke<ToolPanel[]>('panels:list', [sessionId]);
  }

  getActivePanel(sessionId: string): Promise<ToolPanel | null> {
    return this.invoke<ToolPanel | null>('panels:getActive', [sessionId]);
  }

  setActivePanel(sessionId: string, panelId: string): Promise<void> {
    return this.invoke<void>('panels:set-active', [sessionId, panelId]);
  }

  getPwaAffordances(): Promise<RemotePwaAffordances> {
    return this.invoke<RemotePwaAffordances>('remote:pwa-affordances');
  }

  createTerminalPanel(sessionId: string, options: { title?: string; initialCommand?: string } = {}): Promise<ToolPanel> {
    const initialState = options.initialCommand
      ? {
          customState: {
            initialCommand: options.initialCommand,
          },
        }
      : undefined;

    return this.invoke<ToolPanel>('panels:create', [{
      sessionId,
      type: 'terminal',
      title: options.title ?? 'Terminal',
      initialState,
    }]);
  }

  checkPanelInitialized(panelId: string): Promise<boolean> {
    return this.invoke<boolean>('panels:checkInitialized', [panelId]);
  }

  initializePanel(panelId: string, options: { sessionId: string; cols?: number; rows?: number }): Promise<void> {
    return this.invoke<void>('panels:initialize', [panelId, options]);
  }

  getPanelOutput(panelId: string, limit = 5_000): Promise<SessionOutput[]> {
    return this.invoke<SessionOutput[]>('panels:get-output', [panelId, limit]);
  }

  sendTerminalInput(panelId: string, data: string): Promise<void> {
    return this.invoke<void>('terminal:input', [panelId, data]);
  }

  clearTerminalScrollback(panelId: string): Promise<void> {
    return this.invoke<void>('terminal:clearScrollback', [panelId]);
  }

  resizeTerminal(panelId: string, cols: number, rows: number): Promise<void> {
    return this.invoke<void>('terminal:resize', [panelId, cols, rows]);
  }

  setTerminalVisibility(panelId: string, visible: boolean, viewerId: string): Promise<void> {
    return this.invoke<void>('terminal:setVisibility', [panelId, visible, viewerId]);
  }

  ackTerminalOutput(panelId: string, bytes: number): Promise<void> {
    return this.invoke<void>('terminal:ack', [panelId, bytes]);
  }
}

function isIpcResponse<T>(value: IpcLikeResponse<T> | T): value is IpcLikeResponse<T> {
  return Boolean(value && typeof value === 'object' && ('success' in value || 'data' in value || 'error' in value));
}
