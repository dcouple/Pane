import { EventEmitter } from 'events';
import http, { type IncomingMessage, type RequestOptions } from 'http';
import https from 'https';
import { noopPaneEventSink, type PaneEventSink } from '../../core/eventSink';
import type { ConfigManager } from '../../services/configManager';
import { isPaneDaemonEventChannel } from '../server';
import {
  createDefaultRemotePaneConnectionState,
  normalizeRemoteDaemonConfig,
  type RemotePaneConnectionProfile,
  type RemotePaneConnectionState,
  type RemotePaneConnectionStatus,
} from '../../../../shared/types/remoteDaemon';
import type { RemoteDaemonEventEnvelope } from '../../../../shared/types/remoteDaemon';
import { PaneSseParser } from './sseParser';

interface RemotePaneClientOptions {
  eventSink?: PaneEventSink;
  onConnectionStateChange?: (status: RemotePaneConnectionStatus, errorMessage?: string | null) => void;
}

interface RemotePaneClientConnectOptions {
  retryOnInitialFailure?: boolean;
}

interface RemoteInvokeSuccessPayload {
  ok: true;
  result?: unknown;
}

interface RemoteInvokeErrorPayload {
  ok: false;
  error: {
    message: string;
    code?: string;
  };
}

type RemoteInvokeResponsePayload = RemoteInvokeSuccessPayload | RemoteInvokeErrorPayload;

interface JsonResponse {
  statusCode: number;
  body: string;
}

const REMOTE_DAEMON_RECONNECT_DELAY_MS = 1_000;

export class RemotePaneClient {
  private readonly normalizedBaseUrl: URL;
  private readonly eventSink: PaneEventSink;
  private readonly onConnectionStateChange?: (status: RemotePaneConnectionStatus, errorMessage?: string | null) => void;
  private eventParser = new PaneSseParser();
  private eventRequest: http.ClientRequest | null = null;
  private eventResponse: IncomingMessage | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closedByClient = false;

  constructor(
    readonly profile: RemotePaneConnectionProfile,
    options: RemotePaneClientOptions = {},
  ) {
    this.normalizedBaseUrl = normalizeBaseUrl(profile.baseUrl);
    this.eventSink = options.eventSink ?? noopPaneEventSink;
    this.onConnectionStateChange = options.onConnectionStateChange;
  }

  isSameProfile(profile: RemotePaneConnectionProfile): boolean {
    return (
      this.profile.id === profile.id &&
      this.profile.baseUrl === profile.baseUrl &&
      this.profile.token === profile.token
    );
  }

  async connect(options: RemotePaneClientConnectOptions = {}): Promise<void> {
    this.closedByClient = false;
    await this.openEventStream(false, options.retryOnInitialFailure ?? true);
  }

  async disconnect(): Promise<void> {
    this.closedByClient = true;
    this.clearReconnectTimer();
    this.eventParser.reset();

    if (this.eventResponse && !this.eventResponse.destroyed) {
      this.eventResponse.destroy();
    }
    this.eventResponse = null;

    if (this.eventRequest) {
      this.eventRequest.destroy();
    }
    this.eventRequest = null;
  }

  async invoke(channel: string, args: unknown[]): Promise<unknown> {
    const endpoint = new URL('/invoke', this.normalizedBaseUrl);
    const response = await requestJson(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.profile.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
    }, JSON.stringify({ channel, args }));

    const payload = parseJsonResponse<RemoteInvokeResponsePayload>(
      response,
      'Remote daemon returned an invalid invoke response',
    );

    if (!payload.ok) {
      throw new Error(payload.error.message);
    }

    return payload.result;
  }

  private async openEventStream(isReconnect: boolean, retryOnInitialFailure: boolean): Promise<void> {
    this.clearReconnectTimer();
    this.onConnectionStateChange?.(isReconnect ? 'reconnecting' : 'connecting', null);

    const endpoint = new URL('/events', this.normalizedBaseUrl);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let readyReceived = false;
      const request = createRequest(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.profile.token}`,
          Accept: 'text/event-stream',
        },
      }, async (response) => {
        if (response.statusCode !== 200) {
          const body = await readResponseBody(response);
          const message = extractRemoteErrorMessage(body)
            ?? `Remote daemon event stream failed with status ${response.statusCode ?? 'unknown'}`;
          this.handleInitialConnectionFailure(message, retryOnInitialFailure);
          if (!settled) {
            settled = true;
            reject(new Error(message));
          }
          return;
        }

        this.eventResponse = response;
        this.eventParser.reset();

        response.on('data', (chunk: Buffer) => {
          const events = this.eventParser.push(chunk);
          for (const event of events) {
            if (event.event === 'ready') {
              readyReceived = true;
              this.onConnectionStateChange?.('connected', null);
              if (!settled) {
                settled = true;
                resolve();
              }
              continue;
            }

            if (event.event !== 'daemon-event') {
              continue;
            }

            try {
              const envelope = JSON.parse(event.data) as RemoteDaemonEventEnvelope;
              if (!isRemoteDaemonEventEnvelope(envelope) || !isPaneDaemonEventChannel(envelope.channel)) {
                continue;
              }

              this.eventSink.send(envelope.channel, ...envelope.args);
            } catch (error) {
              console.error('[Pane remote daemon] Failed to parse daemon event payload', error);
            }
          }
        });

        response.on('error', (error) => {
          const message = getErrorMessage(error, 'Remote daemon event stream errored');
          if (readyReceived) {
            this.handleUnexpectedDisconnect(message);
          } else {
            this.handleInitialConnectionFailure(message, retryOnInitialFailure);
          }
          if (!settled) {
            settled = true;
            reject(new Error(message));
          }
        });

        response.on('end', () => {
          const message = 'Remote daemon event stream ended';
          if (readyReceived) {
            this.handleUnexpectedDisconnect(message);
          } else {
            this.handleInitialConnectionFailure(message, retryOnInitialFailure);
          }
          if (!settled) {
            settled = true;
            reject(new Error(message));
          }
        });

        response.on('close', () => {
          const message = 'Remote daemon event stream closed';
          if (readyReceived) {
            this.handleUnexpectedDisconnect(message);
          } else {
            this.handleInitialConnectionFailure(message, retryOnInitialFailure);
          }
          if (!settled) {
            settled = true;
            reject(new Error(message));
          }
        });
      });

      this.eventRequest = request;

      request.on('error', (error) => {
        const message = getErrorMessage(error, 'Failed to connect to remote daemon event stream');
        this.handleInitialConnectionFailure(message, retryOnInitialFailure);
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      });

      request.end();
    });
  }

  private handleInitialConnectionFailure(message: string, retryOnInitialFailure: boolean): void {
    this.eventResponse = null;
    this.eventRequest = null;
    this.eventParser.reset();

    if (this.closedByClient) {
      return;
    }

    this.onConnectionStateChange?.('error', message);
    if (retryOnInitialFailure) {
      this.scheduleReconnect(message);
    }
  }

  private handleUnexpectedDisconnect(message: string): void {
    this.eventResponse = null;
    this.eventRequest = null;
    this.eventParser.reset();

    if (this.closedByClient) {
      return;
    }

    this.scheduleReconnect(message);
  }

  private scheduleReconnect(message: string): void {
    if (this.closedByClient || this.reconnectTimer) {
      return;
    }

    this.onConnectionStateChange?.('reconnecting', message);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openEventStream(true, true).catch((error) => {
        const nextMessage = getErrorMessage(error, 'Failed to reconnect to remote daemon event stream');
        this.onConnectionStateChange?.('error', nextMessage);
        this.scheduleReconnect(nextMessage);
      });
    }, REMOTE_DAEMON_RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

interface RemotePaneClientControllerOptions {
  configManager: ConfigManager;
  rendererEventSink: PaneEventSink;
}

export class RemotePaneClientController extends EventEmitter {
  private configManager: ConfigManager | null = null;
  private rendererEventSink: PaneEventSink = noopPaneEventSink;
  private activeClient: RemotePaneClient | null = null;
  private state = createDefaultRemotePaneConnectionState();
  private configListenerAttached = false;

  private readonly configUpdatedListener = () => {
    void this.syncToConfig().catch((error) => {
      this.setConnectionState({
        ...this.state,
        mode: 'remote',
        status: 'error',
        lastError: getErrorMessage(error, 'Failed to sync remote daemon client state'),
      });
    });
  };

  initialize(options: RemotePaneClientControllerOptions): void {
    if (this.configManager && this.configListenerAttached) {
      this.configManager.off('config-updated', this.configUpdatedListener);
      this.configListenerAttached = false;
    }

    this.configManager = options.configManager;
    this.rendererEventSink = options.rendererEventSink;
    this.configManager.on('config-updated', this.configUpdatedListener);
    this.configListenerAttached = true;

    void this.syncToConfig().catch((error) => {
      this.setConnectionState({
        ...this.state,
        mode: 'remote',
        status: 'error',
        lastError: getErrorMessage(error, 'Failed to initialize remote daemon client'),
      });
    });
  }

  getConnectionState(): RemotePaneConnectionState {
    return { ...this.state };
  }

  isRemoteModeActive(): boolean {
    return this.state.mode === 'remote';
  }

  shouldForwardLocalRendererEvent(channel: string): boolean {
    return !this.isRemoteModeActive() || !isPaneDaemonEventChannel(channel);
  }

  async invoke(channel: string, args: unknown[], invokeLocal: () => Promise<unknown>): Promise<unknown> {
    if (!this.isRemoteModeActive()) {
      return invokeLocal();
    }

    if (!this.activeClient) {
      throw new Error(this.state.lastError ?? 'Remote Pane client is not connected');
    }

    return this.activeClient.invoke(channel, args);
  }

  async activateProfile(profile: RemotePaneConnectionProfile): Promise<RemotePaneConnectionState> {
    try {
      await this.connectProfile(profile, { retryOnInitialFailure: false });
      return this.getConnectionState();
    } catch (error) {
      await this.syncToConfig().catch((syncError) => {
        console.error('[Pane remote daemon] Failed to restore saved client state after activation error', syncError);
      });
      throw error;
    }
  }

  async switchToLocalMode(): Promise<RemotePaneConnectionState> {
    await this.disconnectActiveClient();
    this.setConnectionState(createDefaultRemotePaneConnectionState());
    return this.getConnectionState();
  }

  async syncToConfig(): Promise<void> {
    if (!this.configManager) {
      return;
    }

    const remoteConfig = normalizeRemoteDaemonConfig(this.configManager.getConfig().remoteDaemon);
    const activeProfileId = remoteConfig.client.activeProfileId;
    if (remoteConfig.client.mode !== 'remote' || !activeProfileId) {
      await this.disconnectActiveClient();
      this.setConnectionState(createDefaultRemotePaneConnectionState());
      return;
    }

    const activeProfile = remoteConfig.client.profiles.find((profile) => profile.id === activeProfileId);
    if (!activeProfile) {
      await this.disconnectActiveClient();
      this.setConnectionState({
        mode: 'remote',
        status: 'error',
        activeProfileId,
        activeProfileLabel: null,
        activeBaseUrl: null,
        lastError: `Remote daemon connection profile "${activeProfileId}" does not exist`,
      });
      return;
    }

    if (this.activeClient?.isSameProfile(activeProfile)) {
      this.setConnectionState({
        ...this.state,
        mode: 'remote',
        activeProfileId: activeProfile.id,
        activeProfileLabel: activeProfile.label,
        activeBaseUrl: activeProfile.baseUrl,
      });
      return;
    }

    await this.connectProfile(activeProfile, { retryOnInitialFailure: true });
  }

  private async connectProfile(
    profile: RemotePaneConnectionProfile,
    options: RemotePaneClientConnectOptions,
  ): Promise<void> {
    await this.disconnectActiveClient();

    const client = new RemotePaneClient(profile, {
      eventSink: this.rendererEventSink,
      onConnectionStateChange: (status, errorMessage) => {
        this.setConnectionState({
          mode: 'remote',
          status,
          activeProfileId: profile.id,
          activeProfileLabel: profile.label,
          activeBaseUrl: profile.baseUrl,
          lastError: errorMessage ?? null,
        });
      },
    });

    this.activeClient = client;
    try {
      await client.connect({
        retryOnInitialFailure: options.retryOnInitialFailure,
      });
      this.setConnectionState({
        mode: 'remote',
        status: 'connected',
        activeProfileId: profile.id,
        activeProfileLabel: profile.label,
        activeBaseUrl: profile.baseUrl,
        lastError: null,
      });
    } catch (error) {
      if (!options.retryOnInitialFailure || this.activeClient !== client) {
        if (this.activeClient === client) {
          this.activeClient = null;
        }
        await client.disconnect();
      }
      this.setConnectionState({
        mode: 'remote',
        status: 'error',
        activeProfileId: profile.id,
        activeProfileLabel: profile.label,
        activeBaseUrl: profile.baseUrl,
        lastError: getErrorMessage(error, `Failed to connect to remote daemon profile "${profile.label}"`),
      });
      throw error;
    }
  }

  private async disconnectActiveClient(): Promise<void> {
    const client = this.activeClient;
    this.activeClient = null;
    if (client) {
      await client.disconnect();
    }
  }

  private setConnectionState(nextState: RemotePaneConnectionState): void {
    this.state = nextState;
    this.emit('state-changed', this.getConnectionState());
    this.rendererEventSink.send('remote-daemon:connection-state-changed', this.getConnectionState());
  }
}

export const remotePaneClientController = new RemotePaneClientController();

function normalizeBaseUrl(baseUrl: string): URL {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(normalized);
}

function createRequest(
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
): http.ClientRequest {
  const transport = url.protocol === 'https:' ? https : http;
  return transport.request(url, options, onResponse);
}

async function requestJson(
  url: URL,
  options: RequestOptions,
  body: string,
): Promise<JsonResponse> {
  return await new Promise<JsonResponse>((resolve, reject) => {
    const request = createRequest(url, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      void readResponseBody(response).then((responseBody) => {
        resolve({
          statusCode: response.statusCode ?? 500,
          body: responseBody,
        });
      }).catch(reject);
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function readResponseBody(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonResponse<T>(response: JsonResponse, fallbackMessage: string): T {
  try {
    return JSON.parse(response.body) as T;
  } catch (error) {
    throw new Error(
      `${fallbackMessage}: ${getErrorMessage(error, 'Unknown JSON parse failure')}`,
    );
  }
}

function extractRemoteErrorMessage(body: string): string | null {
  if (body.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(body) as Partial<RemoteInvokeErrorPayload>;
    return parsed.error?.message ?? null;
  } catch {
    return body;
  }
}

function isRemoteDaemonEventEnvelope(value: unknown): value is RemoteDaemonEventEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<RemoteDaemonEventEnvelope>;
  return (
    typeof candidate.channel === 'string' &&
    Array.isArray(candidate.args) &&
    typeof candidate.timestamp === 'string'
  );
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
