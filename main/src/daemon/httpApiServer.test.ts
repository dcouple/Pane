import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { PaneCommandRegistry } from './commandRegistry';
import { hashRemoteDaemonToken } from './auth';
import { PaneRemoteHttpApiServer } from './httpApiServer';

interface ConfigManagerStub {
  getConfig(): { remoteDaemon?: RemoteDaemonConfig };
}

interface TestEventStream {
  close(): void;
  nextEvent(timeoutMs?: number): Promise<{ event: string | null; data: string[] }>;
}

const activeServers: PaneRemoteHttpApiServer[] = [];
const activeRequests = new Set<http.ClientRequest>();

afterEach(async () => {
  for (const request of activeRequests) {
    request.destroy();
  }
  activeRequests.clear();

  for (const server of activeServers.splice(0)) {
    await server.stop();
  }
});

function createConfigManagerStub(config?: RemoteDaemonConfig): ConfigManagerStub {
  const remoteDaemon = config;

  return {
    getConfig() {
      return { remoteDaemon };
    },
  };
}

function createEnabledRemoteConfig(overrides?: Partial<RemoteDaemonConfig['host']['config']>): RemoteDaemonConfig {
  const config = createDefaultRemoteDaemonConfig();
  config.host.config = {
    ...config.host.config,
    enabled: true,
    listenHost: '127.0.0.1',
    listenPort: 0,
    ...overrides,
  };
  config.host.clients = [{
    id: 'client-1',
    label: 'Mac mini',
    createdAt: new Date('2026-05-14T00:00:00.000Z').toISOString(),
    tokenHash: hashRemoteDaemonToken('secret-token'),
  }];
  return config;
}

async function requestJson(
  server: PaneRemoteHttpApiServer,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ statusCode: number; body: unknown }> {
  const address = server.getAddress();
  if (!address) {
    throw new Error('Remote HTTP API server is not listening');
  }

  return new Promise((resolve, reject) => {
    const request = http.request({
      host: address.host,
      port: address.port,
      path,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: response.statusCode ?? 0,
          body: text.length > 0 ? JSON.parse(text) : null,
        });
      });
    });

    activeRequests.add(request);
    request.once('error', reject);
    if (body !== undefined) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

async function openEventStream(server: PaneRemoteHttpApiServer, token?: string): Promise<TestEventStream> {
  const address = server.getAddress();
  if (!address) {
    throw new Error('Remote HTTP API server is not listening');
  }

  return new Promise((resolve, reject) => {
    const request = http.request({
      host: address.host,
      port: address.port,
      path: '/events',
      method: 'GET',
      headers: token ? {
        Authorization: `Bearer ${token}`,
      } : undefined,
    });

    activeRequests.add(request);
    request.once('error', reject);
    request.on('response', (response) => {
      const queuedEvents: Array<{ event: string | null; data: string[] }> = [];
      const waiters: Array<(event: { event: string | null; data: string[] }) => void> = [];
      let buffer = '';

      response.on('data', (chunk) => {
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

        let boundaryIndex = buffer.indexOf('\n\n');
        while (boundaryIndex !== -1) {
          const rawEvent = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);

          const parsedEvent = parseSseEvent(rawEvent);
          if (parsedEvent) {
            const waiter = waiters.shift();
            if (waiter) {
              waiter(parsedEvent);
            } else {
              queuedEvents.push(parsedEvent);
            }
          }

          boundaryIndex = buffer.indexOf('\n\n');
        }
      });

      resolve({
        close() {
          request.destroy();
        },
        nextEvent(timeoutMs = 1000) {
          if (queuedEvents.length > 0) {
            return Promise.resolve(queuedEvents.shift() as { event: string | null; data: string[] });
          }

          return new Promise((eventResolve, eventReject) => {
            const timeout = setTimeout(() => {
              eventReject(new Error('Timed out waiting for SSE event'));
            }, timeoutMs);

            waiters.push((event) => {
              clearTimeout(timeout);
              eventResolve(event);
            });
          });
        },
      });
    });

    request.end();
  });
}

function parseSseEvent(rawEvent: string): { event: string | null; data: string[] } | null {
  const lines = rawEvent.split('\n');
  let event: string | null = null;
  const data: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      event = line.slice('event: '.length);
      continue;
    }

    if (line.startsWith('data: ')) {
      data.push(line.slice('data: '.length));
    }
  }

  if (!event && data.length === 0) {
    return null;
  }

  return { event, data };
}

describe('PaneRemoteHttpApiServer', () => {
  it('invokes daemon-owned commands over authenticated HTTP', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', async () => [{ id: 'session-1' }]);

    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()) as never);
    activeServers.push(server);
    await server.start();

    await expect(requestJson(server, 'POST', '/invoke', {
      channel: 'sessions:get-all',
      args: [],
    }, 'secret-token')).resolves.toEqual({
      statusCode: 200,
      body: {
        ok: true,
        result: [{ id: 'session-1' }],
      },
    });
  });

  it('rejects invoke requests without bearer auth', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', async () => []);

    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()) as never);
    activeServers.push(server);
    await server.start();

    await expect(requestJson(server, 'POST', '/invoke', {
      channel: 'sessions:get-all',
      args: [],
    })).resolves.toEqual({
      statusCode: 401,
      body: {
        ok: false,
        statusCode: 401,
        error: {
          message: 'Remote daemon bearer token is required',
          code: 'ERR_REMOTE_DAEMON_AUTH_REQUIRED',
        },
      },
    });
  });

  it('allows unauthenticated remote requests when pairing is disabled', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', async () => [{ id: 'session-1' }]);

    const server = new PaneRemoteHttpApiServer(
      registry,
      createConfigManagerStub(createEnabledRemoteConfig({ pairingRequired: false })) as never,
    );
    activeServers.push(server);
    await server.start();

    await expect(requestJson(server, 'POST', '/invoke', {
      channel: 'sessions:get-all',
      args: [],
    })).resolves.toEqual({
      statusCode: 200,
      body: {
        ok: true,
        result: [{ id: 'session-1' }],
      },
    });

    const stream = await openEventStream(server);
    const readyEvent = await stream.nextEvent();
    expect(readyEvent.event).toBe('ready');

    stream.close();
  });

  it('rejects oversized invoke request bodies with a client error', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', async () => []);

    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()) as never);
    activeServers.push(server);
    await server.start();

    const oversizedArgs = ['x'.repeat(1024 * 1024)];
    await expect(requestJson(server, 'POST', '/invoke', {
      channel: 'sessions:get-all',
      args: oversizedArgs,
    }, 'secret-token')).resolves.toEqual({
      statusCode: 413,
      body: {
        ok: false,
        error: {
          message: 'Remote daemon request body exceeds the 1 MB limit',
          code: 'ERR_REMOTE_DAEMON_REQUEST_TOO_LARGE',
        },
      },
    });
  });

  it('streams a ready event and daemon-owned runtime events over SSE', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()) as never);
    activeServers.push(server);
    await server.start();

    const stream = await openEventStream(server, 'secret-token');
    const readyEvent = await stream.nextEvent();
    expect(readyEvent.event).toBe('ready');
    expect(JSON.parse(readyEvent.data.join('\n'))).toMatchObject({
      replay: 'none',
      resync: 'refetch-state-after-reconnect',
    });

    server.getEventSink().send('session:created', { id: 'session-1' });

    const daemonEvent = await stream.nextEvent();
    expect(daemonEvent.event).toBe('daemon-event');
    expect(JSON.parse(daemonEvent.data.join('\n'))).toEqual({
      channel: 'session:created',
      args: [{ id: 'session-1' }],
      timestamp: expect.any(String),
    });

    stream.close();
  });

  it('filters non-daemon events from the remote SSE stream', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()) as never);
    activeServers.push(server);
    await server.start();

    const stream = await openEventStream(server, 'secret-token');
    await stream.nextEvent();

    server.getEventSink().send('version:update-available', { version: '1.2.3' });
    await expect(stream.nextEvent(100)).rejects.toThrow('Timed out waiting for SSE event');

    stream.close();
  });

  it('drops existing SSE subscribers when the paired client token rotates', async () => {
    const registry = new PaneCommandRegistry();
    const remoteConfig = createEnabledRemoteConfig();
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(remoteConfig) as never);
    activeServers.push(server);
    await server.start();

    const stream = await openEventStream(server, 'secret-token');
    await stream.nextEvent();

    remoteConfig.host.clients = [{
      ...remoteConfig.host.clients[0],
      tokenHash: hashRemoteDaemonToken('rotated-token'),
    }];

    server.getEventSink().send('session:created', { id: 'session-1' });
    await expect(stream.nextEvent(100)).rejects.toThrow('Timed out waiting for SSE event');

    stream.close();
  });

  it('refuses direct loopback HTTP when config disables insecure loopback mode', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneRemoteHttpApiServer(
      registry,
      createConfigManagerStub(createEnabledRemoteConfig({ allowInsecureHttpOnLoopback: false })) as never,
    );

    await expect(server.start()).rejects.toThrow('Remote daemon HTTP API loopback transport is disabled by config');
  });

  it('refuses direct HTTP on non-loopback listen hosts', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneRemoteHttpApiServer(
      registry,
      createConfigManagerStub(createEnabledRemoteConfig({ listenHost: '0.0.0.0' })) as never,
    );

    await expect(server.start()).rejects.toThrow(
      'Remote daemon direct HTTP only supports loopback listen hosts; keep listenHost on 127.0.0.1, ::1, or localhost and expose it through an SSH tunnel, Tailscale/VPN, or a reverse proxy.',
    );
  });
});
