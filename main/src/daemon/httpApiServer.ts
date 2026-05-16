import http, { type IncomingMessage, type ServerResponse } from 'http';
import { createFanoutEventSink, noopPaneEventSink, type PaneEventSink } from '../core/eventSink';
import type { ConfigManager } from '../services/configManager';
import type { PaneCommandRegistry } from './commandRegistry';
import { authenticateRemoteDaemonBearerToken } from './auth';
import { isPaneDaemonEventChannel } from './server';
import {
  createDefaultRemoteDaemonConfig,
  getRemoteDaemonHostConfigValidationError,
  type RemoteDaemonConfig,
  type RemoteDaemonEventEnvelope,
  type RemoteInvokeRequest,
} from '../../../shared/types/remoteDaemon';

interface RemoteHttpAddress {
  host: string;
  port: number;
}

interface ConnectedRemoteEventClient {
  id: string;
  response: ServerResponse;
  remoteClientId: string;
  remoteClientTokenHash: string;
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

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

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

  constructor(
    private readonly commandRegistry: PaneCommandRegistry,
    private readonly configManager: ConfigManager,
  ) {
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

    if (url.pathname === '/invoke') {
      await this.handleInvokeRequest(request, response);
      return;
    }

    if (url.pathname === '/events') {
      this.handleEventStreamRequest(request, response);
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

    const auth = this.authenticateRequest(request);
    if (!auth.ok) {
      this.writeJson(response, auth.statusCode, auth);
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

    try {
      const result = await this.commandRegistry.invoke(invokeRequest.channel, invokeRequest.args);
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

  private handleEventStreamRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'GET') {
      this.writeMethodNotAllowed(response, 'GET');
      return;
    }

    const auth = this.authenticateRequest(request);
    if (!auth.ok) {
      this.writeJson(response, auth.statusCode, auth);
      return;
    }

    response.writeHead(200, {
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
    this.eventClients.set(clientConnectionId, {
      id: clientConnectionId,
      response,
      remoteClientId: auth.client.id,
      remoteClientTokenHash: auth.client.tokenHash,
    });

    const cleanup = () => {
      this.eventClients.delete(clientConnectionId);
    };

    request.on('close', cleanup);
    response.on('close', cleanup);
  }

  private authenticateRequest(request: IncomingMessage) {
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

    return authenticateRemoteDaemonBearerToken(
      request.headers.authorization,
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
    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(payload));
  }

  private writeMethodNotAllowed(response: ServerResponse, method: 'GET' | 'POST'): void {
    response.writeHead(405, {
      Allow: method,
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({
      ok: false,
      error: {
        message: `Remote daemon endpoint only supports ${method}`,
        code: 'ERR_REMOTE_DAEMON_METHOD_NOT_ALLOWED',
      },
    }));
  }

  private shouldKeepEventClient(remoteClientId: string, remoteClientTokenHash: string): boolean {
    const remoteConfig = this.getRemoteConfig();
    if (!remoteConfig.host.config.enabled) {
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

    this.eventClients.delete(clientConnectionId);
    if (!client.response.writableEnded) {
      client.response.end();
    }
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

function writeSseEvent(response: ServerResponse, eventName: string, payload: RemoteReadyEventPayload | RemoteDaemonEventEnvelope): void {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function isRemoteInvokeRequest(value: unknown): value is RemoteInvokeRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<RemoteInvokeRequest>;
  return typeof candidate.channel === 'string' && candidate.channel.length > 0 && Array.isArray(candidate.args);
}
