import http, { type IncomingMessage, type ServerResponse } from 'http';
import { createFanoutEventSink, noopPaneEventSink, type PaneEventSink } from '../core/eventSink';
import type { ConfigManager } from '../services/configManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import type { PaneCommandRegistry } from './commandRegistry';
import { authenticateRemoteDaemonBearerToken } from './auth';
import { isPaneDaemonEventChannel } from './server';
import {
  createDefaultRemoteDaemonConfig,
  getRemoteDaemonHostConfigValidationError,
  type RemoteDaemonConnectedClient,
  type RemoteDaemonConfig,
  type RemoteDaemonEventEnvelope,
  type RemoteDaemonHeartbeatPayload,
  type RemoteInvokeRequest,
} from '../../../shared/types/remoteDaemon';
import { remoteHostRuntimeStateStore } from './remoteHostRuntimeState';
import { getRemotePwaAssetResponse } from './pwaStaticAssets';

interface RemoteHttpAddress {
  host: string;
  port: number;
}

interface ConnectedRemoteEventClient {
  id: string;
  response: ServerResponse;
  remoteClientId: string | null;
  remoteClientTokenHash: string | null;
  label: string | null;
  deviceLabel: string | null;
  remoteRuntimeId: string | null;
  remoteAddress: string | null;
  connectedAt: string;
  lastSeenAt: string;
  heartbeatTimer: NodeJS.Timeout;
}

interface RemoteInvokeSuccessPayload {
  ok: true;
  result: unknown;
}

interface RemoteInvokeErrorPayload {
  ok: false;
  error: {
    message: string;
    code: string;
  };
}

interface RemoteReadyEventPayload {
  replay: 'none';
  resync: 'refetch-state-after-reconnect';
  timestamp: string;
}

interface RemoteHealthPayload {
  ok: true;
  status: 'ready';
  transport: 'http+sse';
}

type RemoteRequestAuthResult =
  | {
    ok: true;
    client: {
      id: string;
      tokenHash: string;
      label: string;
    } | null;
  }
  | {
    ok: false;
    statusCode: number;
    error: {
      message: string;
      code: string;
    };
  };

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const DEFAULT_REMOTE_DAEMON_HEARTBEAT_INTERVAL_MS = 5_000;
const REMOTE_VISIBILITY_VIEWER_STALE_MS = 15 * 60 * 1000;
const REMOTE_DAEMON_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': [
    'Authorization',
    'Content-Type',
    'X-Pane-Remote-Runtime-Id',
    'X-Pane-Remote-Client-Label',
    'X-Pane-Client-Label',
    'X-Pane-Client-Device-Label',
  ].join(', '),
  'Access-Control-Max-Age': '86400',
};

interface PaneRemoteHttpApiServerOptions {
  heartbeatIntervalMs?: number;
}

class RemoteDaemonBadRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'RemoteDaemonBadRequestError';
  }
}

export class PaneRemoteHttpApiServer {
  private server: http.Server | null = null;
  private readonly eventClients = new Map<string, ConnectedRemoteEventClient>();
  private readonly daemonEventSink: PaneEventSink;
  private address: RemoteHttpAddress | null = null;
  private nextClientConnectionId = 1;
  private readonly heartbeatIntervalMs: number;

  constructor(
    private readonly commandRegistry: PaneCommandRegistry,
    private readonly configManager: ConfigManager,
    options: PaneRemoteHttpApiServerOptions = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_REMOTE_DAEMON_HEARTBEAT_INTERVAL_MS;
    this.daemonEventSink = createFanoutEventSink([
      {
        send: (channel, ...args) => {
          if (!isPaneDaemonEventChannel(channel) || this.eventClients.size === 0) {
            return;
          }

          const payload: RemoteDaemonEventEnvelope = {
            channel,
            args,
            timestamp: new Date().toISOString(),
          };

          for (const [clientConnectionId, client] of this.eventClients) {
            if (!this.shouldKeepEventClient(client.remoteClientId, client.remoteClientTokenHash)) {
              this.dropEventClient(clientConnectionId);
              continue;
            }

            try {
              writeSseEvent(client.response, 'daemon-event', payload);
            } catch {
              this.dropEventClient(clientConnectionId);
            }
          }
        },
      },
      noopPaneEventSink,
    ]);
  }

  getAddress(): RemoteHttpAddress | null {
    return this.address;
  }

  getEventSink(): PaneEventSink {
    return this.daemonEventSink;
  }

  getConnectedClients(): RemoteDaemonConnectedClient[] {
    return this.getConnectedClientSnapshots();
  }

  disconnectClients(clientIds?: string[]): number {
    const clientIdSet = clientIds ? new Set(clientIds) : null;
    const clientConnectionIds = [...this.eventClients.entries()]
      .filter(([, client]) => !clientIdSet || (client.remoteClientId !== null && clientIdSet.has(client.remoteClientId)))
      .map(([clientConnectionId]) => clientConnectionId);

    for (const clientConnectionId of clientConnectionIds) {
      this.dropEventClient(clientConnectionId);
    }

    return clientConnectionIds.length;
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Remote daemon HTTP API server is already running');
    }

    const hostConfig = this.getRemoteConfig().host.config;
    if (!hostConfig.enabled) {
      throw new Error('Remote daemon HTTP API server is disabled in config');
    }

    const hostConfigError = getRemoteDaemonHostConfigValidationError(hostConfig);
    if (hostConfigError) {
      throw new Error(hostConfigError);
    }

    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) {
          this.writeJson(response, 500, {
            ok: false,
            error: {
              message,
              code: 'ERR_REMOTE_DAEMON_HTTP_INTERNAL',
            },
          });
          return;
        }

        response.destroy(error instanceof Error ? error : new Error(message));
      });
    });

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        server.removeListener('listening', handleListening);
        reject(error);
      };

      const handleListening = () => {
        server.removeListener('error', handleError);
        resolve();
      };

      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(hostConfig.listenPort, hostConfig.listenHost);
    });

    server.on('error', (error) => {
      console.error('[Pane remote daemon] HTTP server error:', error);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Remote daemon HTTP API server did not expose a TCP address');
    }

    this.server = server;
    this.address = {
      host: hostConfig.listenHost,
      port: address.port,
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.address = null;

    for (const clientConnectionId of [...this.eventClients.keys()]) {
      this.dropEventClient(clientConnectionId);
    }

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (request.method === 'OPTIONS') {
      response.writeHead(204, withCorsHeaders());
      response.end();
      return;
    }

    if (url.pathname === '/invoke') {
      await this.handleInvokeRequest(request, response);
      return;
    }

    if (url.pathname === '/health') {
      this.handleHealthRequest(request, response);
      return;
    }

    if (url.pathname === '/events') {
      this.handleEventStreamRequest(request, response, url);
      return;
    }

    const remotePwaResponse = await getRemotePwaAssetResponse(url.pathname);
    if (remotePwaResponse.handled) {
      response.writeHead(remotePwaResponse.statusCode ?? 200, withCorsHeaders(remotePwaResponse.headers ?? {}));
      response.end(remotePwaResponse.body ?? '');
      return;
    }

    this.writeJson(response, 404, {
      ok: false,
      error: {
        message: `Remote daemon endpoint "${url.pathname}" does not exist`,
        code: 'ERR_REMOTE_DAEMON_HTTP_NOT_FOUND',
      },
    });
  }

  private async handleInvokeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      this.writeMethodNotAllowed(response, 'POST');
      return;
    }

    let invokeRequest: RemoteInvokeRequest;
    try {
      invokeRequest = await this.readInvokeRequest(request);
    } catch (error) {
      if (error instanceof RemoteDaemonBadRequestError) {
        this.writeJson(response, error.statusCode, {
          ok: false,
          error: {
            message: error.message,
            code: error.code,
          },
        });
        return;
      }

      throw error;
    }

    const auth = this.authenticateRequest(request, invokeRequest.token);
    if (!auth.ok) {
      this.writeJson(response, auth.statusCode, auth);
      return;
    }

    try {
      const result = await this.commandRegistry.invoke(
        invokeRequest.channel,
        this.getInvokeArgsForRequest(invokeRequest, auth, request),
      );
      this.writeJson(response, 200, {
        ok: true,
        result,
      } satisfies RemoteInvokeSuccessPayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes('No Pane daemon command registered')
        ? 'ERR_UNKNOWN_CHANNEL'
        : 'ERR_REMOTE_DAEMON_REQUEST_FAILED';
      const statusCode = code === 'ERR_UNKNOWN_CHANNEL' ? 404 : 500;

      this.writeJson(response, statusCode, {
        ok: false,
        error: {
          message,
          code,
        },
      } satisfies RemoteInvokeErrorPayload);
    }
  }

  private handleHealthRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'GET') {
      this.writeMethodNotAllowed(response, 'GET');
      return;
    }

    this.writeJson(response, 200, {
      ok: true,
      status: 'ready',
      transport: 'http+sse',
    } satisfies RemoteHealthPayload);
  }

  private handleEventStreamRequest(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (request.method !== 'GET') {
      this.writeMethodNotAllowed(response, 'GET');
      return;
    }

    const auth = this.authenticateRequest(request, url.searchParams.get('access_token'));
    if (!auth.ok) {
      this.writeJson(response, auth.statusCode, auth);
      return;
    }

    response.writeHead(200, {
      ...REMOTE_DAEMON_CORS_HEADERS,
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    response.write('retry: 1000\n\n');
    writeSseEvent(response, 'ready', {
      replay: 'none',
      resync: 'refetch-state-after-reconnect',
      timestamp: new Date().toISOString(),
    } satisfies RemoteReadyEventPayload);

    const clientConnectionId = String(this.nextClientConnectionId++);
    const connectedAt = new Date().toISOString();
    const heartbeatTimer = setInterval(() => {
      this.sendHeartbeat(clientConnectionId);
    }, this.heartbeatIntervalMs);
    this.eventClients.set(clientConnectionId, {
      id: clientConnectionId,
      response,
      remoteClientId: auth.client?.id ?? null,
      remoteClientTokenHash: auth.client?.tokenHash ?? null,
      label: auth.client?.label ?? getClientLabelFromRequest(request, url.searchParams.get('client_label')),
      deviceLabel: getClientDeviceLabelFromHeaders(request),
      remoteRuntimeId: getRemoteRuntimeIdFromRequest(request, url.searchParams.get('runtime_id')),
      remoteAddress: getRemoteAddress(request),
      connectedAt,
      lastSeenAt: connectedAt,
      heartbeatTimer,
    });
    this.publishConnectedClients();
    this.sendHeartbeat(clientConnectionId);

    const cleanup = () => {
      this.dropEventClient(clientConnectionId);
    };

    request.on('close', cleanup);
    response.on('close', cleanup);
  }

  private authenticateRequest(request: IncomingMessage, token?: string | null): RemoteRequestAuthResult {
    const remoteConfig = this.getRemoteConfig();
    if (!remoteConfig.host.config.enabled) {
      return {
        ok: false as const,
        statusCode: 503,
        error: {
          message: 'Remote daemon HTTP API is disabled',
          code: 'ERR_REMOTE_DAEMON_HTTP_DISABLED',
        },
      };
    }

    if (!remoteConfig.host.config.pairingRequired) {
      return {
        ok: true,
        client: null,
      };
    }

    return authenticateRemoteDaemonBearerToken(
      getAuthorizationHeaderForRequest(request, token),
      remoteConfig.host.clients,
    );
  }

  private async readInvokeRequest(
    request: IncomingMessage,
  ): Promise<RemoteInvokeRequest> {
    const body = await readRequestBody(request);
    if (body.length === 0) {
      throw new RemoteDaemonBadRequestError(
        'ERR_REMOTE_DAEMON_BAD_REQUEST',
        'Remote daemon invoke request body is required',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch (error) {
      throw new RemoteDaemonBadRequestError(
        'ERR_REMOTE_DAEMON_BAD_REQUEST',
        `Failed to parse remote daemon invoke request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (!isRemoteInvokeRequest(parsed)) {
      throw new RemoteDaemonBadRequestError(
        'ERR_REMOTE_DAEMON_BAD_REQUEST',
        'Remote daemon invoke request must contain a channel string and args array',
      );
    }

    return parsed;
  }

  private writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    response.writeHead(statusCode, withCorsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
    }));
    response.end(JSON.stringify(payload));
  }

  private writeMethodNotAllowed(response: ServerResponse, method: 'GET' | 'POST'): void {
    response.writeHead(405, withCorsHeaders({
      Allow: method,
      'Content-Type': 'application/json; charset=utf-8',
    }));
    response.end(JSON.stringify({
      ok: false,
      error: {
        message: `Remote daemon endpoint only supports ${method}`,
        code: 'ERR_REMOTE_DAEMON_METHOD_NOT_ALLOWED',
      },
    }));
  }

  private shouldKeepEventClient(remoteClientId: string | null, remoteClientTokenHash: string | null): boolean {
    const remoteConfig = this.getRemoteConfig();
    if (!remoteConfig.host.config.enabled) {
      return false;
    }

    if (!remoteConfig.host.config.pairingRequired) {
      return true;
    }

    if (!remoteClientId || !remoteClientTokenHash) {
      return false;
    }

    return remoteConfig.host.clients.some((client) => (
      client.id === remoteClientId &&
      client.tokenHash === remoteClientTokenHash
    ));
  }

  private dropEventClient(clientConnectionId: string): void {
    const client = this.eventClients.get(clientConnectionId);
    if (!client) {
      return;
    }

    clearInterval(client.heartbeatTimer);
    terminalPanelManager.clearVisibilityViewersByPrefix(
      this.getRemoteVisibilityViewerPrefix(client.remoteClientId, client.remoteClientTokenHash, client.remoteRuntimeId),
    );
    this.eventClients.delete(clientConnectionId);
    if (!client.response.writableEnded) {
      client.response.end();
    }
    this.publishConnectedClients();
  }

  private sendHeartbeat(clientConnectionId: string): void {
    const client = this.eventClients.get(clientConnectionId);
    if (!client) {
      return;
    }

    const timestamp = new Date().toISOString();
    try {
      writeSseEvent(client.response, 'heartbeat', {
        timestamp,
      } satisfies RemoteDaemonHeartbeatPayload);
      client.lastSeenAt = timestamp;
      terminalPanelManager.pruneVisibilityViewersByPrefix(
        this.getRemoteVisibilityViewerPrefix(client.remoteClientId, client.remoteClientTokenHash, client.remoteRuntimeId),
        REMOTE_VISIBILITY_VIEWER_STALE_MS,
      );
      this.publishConnectedClients();
    } catch {
      this.dropEventClient(clientConnectionId);
    }
  }

  private publishConnectedClients(): void {
    remoteHostRuntimeStateStore.setConnectedClients(this.getConnectedClientSnapshots());
  }

  private getConnectedClientSnapshots(): RemoteDaemonConnectedClient[] {
    return [...this.eventClients.values()].map((client) => ({
      id: client.id,
      clientId: client.remoteClientId,
      label: client.label,
      deviceLabel: client.deviceLabel,
      remoteAddress: client.remoteAddress,
      connectedAt: client.connectedAt,
      lastSeenAt: client.lastSeenAt,
    }));
  }

  private getInvokeArgsForRequest(
    invokeRequest: RemoteInvokeRequest,
    auth: Extract<RemoteRequestAuthResult, { ok: true }>,
    request: IncomingMessage,
  ): unknown[] {
    const args = [...invokeRequest.args];
    if (invokeRequest.channel !== 'terminal:setVisibility') {
      return args;
    }

    const rawViewerId = typeof args[2] === 'string' && args[2].trim().length > 0
      ? args[2]
      : 'default';
    args[2] = `${this.getRemoteVisibilityViewerPrefix(
      auth.client?.id ?? null,
      auth.client?.tokenHash ?? null,
      getRemoteRuntimeIdFromRequest(request, invokeRequest.runtimeId),
    )}:viewer:${sanitizeVisibilityViewerPart(rawViewerId)}`;
    return args;
  }

  private getRemoteVisibilityViewerPrefix(
    remoteClientId: string | null,
    remoteClientTokenHash: string | null,
    remoteRuntimeId: string | null,
  ): string {
    const clientPart = remoteClientId ?? remoteClientTokenHash ?? 'anonymous';
    const runtimePart = remoteRuntimeId ?? 'legacy-runtime';
    return `remote:${sanitizeVisibilityViewerPart(clientPart)}:${sanitizeVisibilityViewerPart(runtimePart)}`;
  }

  private getRemoteConfig(): RemoteDaemonConfig {
    return this.configManager.getConfig().remoteDaemon ?? createDefaultRemoteDaemonConfig();
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalBytes += buffer.length;

    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RemoteDaemonBadRequestError(
        'ERR_REMOTE_DAEMON_REQUEST_TOO_LARGE',
        'Remote daemon request body exceeds the 1 MB limit',
        413,
      );
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function withCorsHeaders(headers: http.OutgoingHttpHeaders = {}): http.OutgoingHttpHeaders {
  return {
    ...REMOTE_DAEMON_CORS_HEADERS,
    ...headers,
  };
}

function writeSseEvent(
  response: ServerResponse,
  eventName: string,
  payload: RemoteReadyEventPayload | RemoteDaemonEventEnvelope | RemoteDaemonHeartbeatPayload,
): void {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getClientLabelFromHeaders(request: IncomingMessage): string | null {
  return getSingleHeaderValue(request.headers['x-pane-client-label']);
}

function getClientLabelFromRequest(request: IncomingMessage, fallback?: string | null): string | null {
  return getClientLabelFromHeaders(request) ?? getSingleString(fallback);
}

function getClientDeviceLabelFromHeaders(request: IncomingMessage): string | null {
  return getSingleHeaderValue(request.headers['x-pane-client-device-label']);
}

function getRemoteRuntimeIdFromHeaders(request: IncomingMessage): string | null {
  return getSingleHeaderValue(request.headers['x-pane-remote-runtime-id']);
}

function getRemoteRuntimeIdFromRequest(request: IncomingMessage, fallback?: string | null): string | null {
  return getRemoteRuntimeIdFromHeaders(request) ?? getSingleString(fallback);
}

function getAuthorizationHeaderForRequest(
  request: IncomingMessage,
  token?: string | null,
): string | string[] | undefined {
  const bodyToken = getSingleString(token);
  return bodyToken ? `Bearer ${bodyToken}` : request.headers.authorization;
}

function sanitizeVisibilityViewerPart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return sanitized || 'unknown';
}

function getRemoteAddress(request: IncomingMessage): string | null {
  const forwardedFor = getSingleHeaderValue(request.headers['x-forwarded-for']);
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || null;
  }

  return request.socket.remoteAddress ?? null;
}

function getSingleHeaderValue(value: string | string[] | undefined): string | null {
  const headerValue = Array.isArray(value) ? value[0] : value;
  return getSingleString(headerValue);
}

function getSingleString(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRemoteInvokeRequest(value: unknown): value is RemoteInvokeRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<RemoteInvokeRequest>;
  return (
    typeof candidate.channel === 'string' &&
    candidate.channel.length > 0 &&
    Array.isArray(candidate.args) &&
    isOptionalString(candidate.token) &&
    isOptionalString(candidate.runtimeId) &&
    isOptionalString(candidate.clientLabel)
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}
