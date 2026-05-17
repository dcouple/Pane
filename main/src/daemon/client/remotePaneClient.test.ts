import http, { type IncomingMessage, type ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import type { PaneEventSink } from '../../core/eventSink';
import { RemotePaneClient, RemotePaneClientController } from './remotePaneClient';

interface TestRemoteServer {
  baseUrl: string;
  close(): Promise<void>;
  closeEventStream(): void;
  emitDaemonEvent(payload: unknown): void;
  getLastInvokeAuth(): string | undefined;
  getLastInvokeBody(): string | undefined;
  getLastInvokePath(): string | undefined;
  getLastEventsPath(): string | undefined;
  setEventsReady(ready: boolean): void;
}

interface ConfigManagerStub extends EventEmitter {
  getConfig(): { remoteDaemon: RemoteDaemonConfig };
  setRemoteConfig(remoteDaemon: RemoteDaemonConfig): void;
}

const activeServers: TestRemoteServer[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    await activeServers.pop()?.close();
  }
});

describe('RemotePaneClient', () => {
  it('sends authenticated invoke requests to the remote daemon', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);

    const client = new RemotePaneClient({
      id: 'profile-1',
      label: 'Mac mini',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    });

    await expect(client.invoke('sessions:get-all', ['session-1'])).resolves.toEqual({
      channel: 'sessions:get-all',
      args: ['session-1'],
    });

    expect(server.getLastInvokeAuth()).toBe('Bearer secret-token');
    expect(server.getLastInvokeBody()).toBe(JSON.stringify({
      channel: 'sessions:get-all',
      args: ['session-1'],
    }));
  });

  it('forwards remote daemon SSE events through the provided renderer sink', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const receivedEvents: Array<{ channel: string; args: unknown[] }> = [];

    const eventSink: PaneEventSink = {
      send(channel, ...args) {
        receivedEvents.push({ channel, args });
      },
    };

    const client = new RemotePaneClient({
      id: 'profile-2',
      label: 'Workstation',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    }, { eventSink });

    await client.connect();
    server.emitDaemonEvent({
      channel: 'session:created',
      args: [{ id: 'session-1' }],
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => receivedEvents.length === 1);
    expect(receivedEvents).toEqual([{
      channel: 'session:created',
      args: [{ id: 'session-1' }],
    }]);

    await client.disconnect();
  });

  it('supports IPv6 loopback connection profiles', async () => {
    const server = await createTestRemoteServer('::1');
    activeServers.push(server);

    const client = new RemotePaneClient({
      id: 'profile-ipv6',
      label: 'IPv6 host',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    });

    await expect(client.invoke('sessions:get-all', ['session-1'])).resolves.toEqual({
      channel: 'sessions:get-all',
      args: ['session-1'],
    });

    expect(server.getLastInvokeAuth()).toBe('Bearer secret-token');
  });

  it('preserves reverse-proxy base path prefixes for invoke and event routes', async () => {
    const server = await createTestRemoteServer('127.0.0.1', '/pane');
    activeServers.push(server);
    const receivedEvents: Array<{ channel: string; args: unknown[] }> = [];

    const client = new RemotePaneClient({
      id: 'profile-subpath',
      label: 'Reverse proxy',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    }, {
      eventSink: {
        send(channel, ...args) {
          receivedEvents.push({ channel, args });
        },
      },
    });

    await client.connect();
    await expect(client.invoke('sessions:get-all', ['session-1'])).resolves.toEqual({
      channel: 'sessions:get-all',
      args: ['session-1'],
    });

    server.emitDaemonEvent({
      channel: 'session:updated',
      args: [{ id: 'session-1', status: 'running' }],
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => receivedEvents.length === 1);
    expect(server.getLastInvokePath()).toBe('/pane/invoke');
    expect(server.getLastEventsPath()).toBe('/pane/events');
    expect(receivedEvents).toEqual([{
      channel: 'session:updated',
      args: [{ id: 'session-1', status: 'running' }],
    }]);

    await client.disconnect();
  });
});

describe('RemotePaneClientController', () => {
  it('syncs into remote mode and suppresses local daemon renderer events', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);

    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client = {
      profiles: [{
        id: 'profile-1',
        label: 'Remote host',
        baseUrl: server.baseUrl,
        token: 'secret-token',
        transport: 'http+sse',
      }],
      activeProfileId: 'profile-1',
      mode: 'remote',
    };
    const configManager = createConfigManagerStub(remoteConfig);

    const controller = new RemotePaneClientController();
    controller.initialize({
      configManager,
      rendererEventSink: { send() {} },
    });

    await waitFor(() => controller.getConnectionState().status === 'connected');
    expect(controller.getConnectionState()).toMatchObject({
      mode: 'remote',
      status: 'connected',
      activeProfileId: 'profile-1',
    });
    expect(controller.shouldForwardLocalRendererEvent('session:created')).toBe(false);
    expect(controller.shouldForwardLocalRendererEvent('window:focus-changed')).toBe(true);
  });

  it('keeps retrying after an initial remote connection failure', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    server.setEventsReady(false);

    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client = {
      profiles: [{
        id: 'profile-retry',
        label: 'Remote host',
        baseUrl: server.baseUrl,
        token: 'secret-token',
        transport: 'http+sse',
      }],
      activeProfileId: 'profile-retry',
      mode: 'remote',
    };
    const configManager = createConfigManagerStub(remoteConfig);

    const controller = new RemotePaneClientController();
    controller.initialize({
      configManager,
      rendererEventSink: { send() {} },
    });

    await waitFor(() => {
      const state = controller.getConnectionState();
      return state.status === 'error' || state.status === 'reconnecting';
    });

    server.setEventsReady(true);

    await waitFor(() => controller.getConnectionState().status === 'connected', 3_000);
    expect(controller.getConnectionState()).toMatchObject({
      mode: 'remote',
      status: 'connected',
      activeProfileId: 'profile-retry',
    });
  });

  it('requests a renderer state resync after reconnecting the remote event stream', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);

    const rendererEvents: Array<{ channel: string; args: unknown[] }> = [];
    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client = {
      profiles: [{
        id: 'profile-resync',
        label: 'Remote host',
        baseUrl: server.baseUrl,
        token: 'secret-token',
        transport: 'http+sse',
      }],
      activeProfileId: 'profile-resync',
      mode: 'remote',
    };
    const configManager = createConfigManagerStub(remoteConfig);

    const controller = new RemotePaneClientController();
    controller.initialize({
      configManager,
      rendererEventSink: {
        send(channel, ...args) {
          rendererEvents.push({ channel, args });
        },
      },
    });

    await waitFor(() => controller.getConnectionState().status === 'connected');
    await waitFor(() => {
      return rendererEvents.filter((event) => event.channel === 'remote-daemon:resync-required').length === 1;
    });
    server.closeEventStream();

    await waitFor(() => {
      return rendererEvents.filter((event) => event.channel === 'remote-daemon:resync-required').length === 2;
    }, 3_000);

    expect(rendererEvents.filter((event) => event.channel === 'remote-daemon:resync-required')).toHaveLength(2);
    expect(controller.getConnectionState()).toMatchObject({
      mode: 'remote',
      status: 'connected',
      activeProfileId: 'profile-resync',
    });
  });

  it('requests a renderer state resync on the first successful remote event stream connection', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);

    const rendererEvents: Array<{ channel: string; args: unknown[] }> = [];
    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client = {
      profiles: [{
        id: 'profile-initial-resync',
        label: 'Remote host',
        baseUrl: server.baseUrl,
        token: 'secret-token',
        transport: 'http+sse',
      }],
      activeProfileId: 'profile-initial-resync',
      mode: 'remote',
    };
    const configManager = createConfigManagerStub(remoteConfig);

    const controller = new RemotePaneClientController();
    controller.initialize({
      configManager,
      rendererEventSink: {
        send(channel, ...args) {
          rendererEvents.push({ channel, args });
        },
      },
    });

    await waitFor(() => {
      return rendererEvents.filter((event) => event.channel === 'remote-daemon:resync-required').length === 1;
    });

    expect(controller.getConnectionState()).toMatchObject({
      mode: 'remote',
      status: 'connected',
      activeProfileId: 'profile-initial-resync',
    });
  });

  it('restores the saved local state when a manual activation fails', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    server.setEventsReady(false);

    const configManager = createConfigManagerStub(createDefaultRemoteDaemonConfig());
    const controller = new RemotePaneClientController();
    controller.initialize({
      configManager,
      rendererEventSink: { send() {} },
    });

    await expect(controller.activateProfile({
      id: 'profile-manual-failure',
      label: 'Tunnel host',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    })).rejects.toThrow('Remote daemon not ready yet');

    expect(controller.getConnectionState()).toMatchObject({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });
    expect(controller.shouldForwardLocalRendererEvent('session:created')).toBe(true);

    server.setEventsReady(true);
    await sleep(1_250);

    expect(controller.getConnectionState()).toMatchObject({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });
  });
});

async function createTestRemoteServer(host = '127.0.0.1', basePath = ''): Promise<TestRemoteServer> {
  let streamResponse: ServerResponse | null = null;
  let lastInvokeAuth: string | undefined;
  let lastInvokeBody: string | undefined;
  let lastInvokePath: string | undefined;
  let lastEventsPath: string | undefined;
  let eventsReady = true;
  const normalizedBasePath = normalizeTestBasePath(basePath);
  const invokePath = `${normalizedBasePath}/invoke`;
  const eventsPath = `${normalizedBasePath}/events`;

  const server = http.createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url === invokePath) {
      lastInvokeAuth = request.headers.authorization;
      lastInvokeBody = await readRequestBody(request);
      lastInvokePath = request.url;
      const parsed = JSON.parse(lastInvokeBody) as { channel: string; args: unknown[] };
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        ok: true,
        result: parsed,
      }));
      return;
    }

    if (request.url === eventsPath) {
      lastEventsPath = request.url;
      if (!eventsReady) {
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          error: {
            message: 'Remote daemon not ready yet',
          },
        }));
        return;
      }

      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      });
      response.flushHeaders();
      response.write('event: ready\n');
      response.write(`data: ${JSON.stringify({ replay: 'none', resync: 'refetch-state-after-reconnect', timestamp: new Date().toISOString() })}\n\n`);
      streamResponse = response;
      request.on('close', () => {
        if (streamResponse === response) {
          streamResponse = null;
        }
      });
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, host, () => resolve());
    server.once('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test remote server failed to bind');
  }

  return {
    baseUrl: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}${normalizedBasePath}`,
    closeEventStream() {
      if (streamResponse && !streamResponse.destroyed) {
        streamResponse.destroy();
      }
    },
    emitDaemonEvent(payload: unknown) {
      if (!streamResponse) {
        throw new Error('Remote event stream is not connected');
      }

      streamResponse.write('event: daemon-event\n');
      streamResponse.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    getLastInvokeAuth() {
      return lastInvokeAuth;
    },
    getLastInvokeBody() {
      return lastInvokeBody;
    },
    getLastInvokePath() {
      return lastInvokePath;
    },
    getLastEventsPath() {
      return lastEventsPath;
    },
    setEventsReady(nextReady: boolean) {
      eventsReady = nextReady;
    },
    async close() {
      if (streamResponse && !streamResponse.writableEnded) {
        streamResponse.end();
      }

      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function normalizeTestBasePath(basePath: string): string {
  if (basePath.length === 0 || basePath === '/') {
    return '';
  }

  const withLeadingSlash = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
}

function createConfigManagerStub(initialConfig: RemoteDaemonConfig): ConfigManagerStub {
  class Stub extends EventEmitter implements ConfigManagerStub {
    private remoteDaemon = initialConfig;

    getConfig(): { remoteDaemon: RemoteDaemonConfig } {
      return { remoteDaemon: this.remoteDaemon };
    }

    setRemoteConfig(remoteDaemon: RemoteDaemonConfig): void {
      this.remoteDaemon = remoteDaemon;
      this.emit('config-updated', { remoteDaemon });
    }
  }

  return new Stub();
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for test condition');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function sleep(timeoutMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}
