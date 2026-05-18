import http from 'http';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { hashRemoteDaemonToken } from './auth';
import { PaneCommandRegistry } from './commandRegistry';
import { remoteHostRuntimeStateStore } from './remoteHostRuntimeState';

vi.mock('../services/terminalPanelManager', () => ({
  terminalPanelManager: {
    clearVisibilityViewersByPrefix: vi.fn(),
    pruneVisibilityViewersByPrefix: vi.fn(),
  },
}));

import { PaneRemoteTransportController } from './remoteTransportController';

interface TestEventStream {
  close(): void;
  nextEvent(timeoutMs?: number): Promise<{ event: string | null; data: string[] }>;
}

class ConfigManagerStub extends EventEmitter {
  private remoteDaemon: RemoteDaemonConfig;

  constructor(initialConfig: RemoteDaemonConfig) {
    super();
    this.remoteDaemon = initialConfig;
  }

  getConfig(): { remoteDaemon: RemoteDaemonConfig } {
    return { remoteDaemon: this.remoteDaemon };
  }

  async updateRemoteDaemonConfig(remoteDaemon: RemoteDaemonConfig): Promise<void> {
    this.remoteDaemon = remoteDaemon;
    this.emit('config-updated', { remoteDaemon });
  }
}

const activeControllers: PaneRemoteTransportController[] = [];
const activeRequests = new Set<http.ClientRequest>();

afterEach(async () => {
  for (const request of activeRequests) {
    request.destroy();
  }
  activeRequests.clear();

  for (const controller of activeControllers.splice(0)) {
    await controller.stopWatchingAndShutdown();
  }

  remoteHostRuntimeStateStore.resetForTests();
});

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

async function openEventStream(server: NonNullable<ReturnType<PaneRemoteTransportController['getServer']>>, token: string): Promise<TestEventStream> {
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
      headers: {
        Authorization: `Bearer ${token}`,
      },
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

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('PaneRemoteTransportController', () => {
  it('starts and stops remote HTTP transport on config updates while keeping a stable event sink', async () => {
    const registry = new PaneCommandRegistry();
    const configManager = new ConfigManagerStub(createDefaultRemoteDaemonConfig());
    const controller = new PaneRemoteTransportController(registry, configManager as never);
    activeControllers.push(controller);
    controller.startWatchingConfig();

    const daemonEventSink = controller.getEventSink();
    await controller.syncToConfig();
    expect(controller.getServer()).toBeNull();
    expect(remoteHostRuntimeStateStore.getState()).toMatchObject({
      enabled: false,
      status: 'inactive',
      listenHost: '127.0.0.1',
      listenPort: 42137,
      lastError: null,
    });

    await configManager.updateRemoteDaemonConfig(createEnabledRemoteConfig());
    await waitFor(() => controller.getServer() !== null);

    const server = controller.getServer();
    if (!server) {
      throw new Error('Remote HTTP API server did not start');
    }
    expect(remoteHostRuntimeStateStore.getState()).toMatchObject({
      enabled: true,
      status: 'live',
      listenHost: '127.0.0.1',
      listenPort: server.getAddress()?.port,
      lastError: null,
    });

    const stream = await openEventStream(server, 'secret-token');
    await stream.nextEvent();
    const heartbeatEvent = await stream.nextEvent();
    expect(heartbeatEvent.event).toBe('heartbeat');
    await waitFor(() => remoteHostRuntimeStateStore.getState().connectedClients.length === 1);
    expect(remoteHostRuntimeStateStore.getState().connectedClients).toMatchObject([{
      clientId: 'client-1',
      label: 'Mac mini',
      remoteAddress: expect.any(String),
      connectedAt: expect.any(String),
      lastSeenAt: expect.any(String),
    }]);

    daemonEventSink.send('session:created', { id: 'session-1' });

    const daemonEvent = await stream.nextEvent();
    expect(daemonEvent.event).toBe('daemon-event');
    expect(JSON.parse(daemonEvent.data.join('\n'))).toEqual({
        channel: 'session:created',
        args: [{ id: 'session-1' }],
        timestamp: expect.any(String),
    });

    stream.close();
    await waitFor(() => remoteHostRuntimeStateStore.getState().connectedClients.length === 0);
    await configManager.updateRemoteDaemonConfig(createDefaultRemoteDaemonConfig());
    await waitFor(() => controller.getServer() === null);
    await waitFor(() => remoteHostRuntimeStateStore.getState().status === 'inactive');
    expect(remoteHostRuntimeStateStore.getState()).toMatchObject({
      enabled: false,
      status: 'inactive',
      listenHost: '127.0.0.1',
      listenPort: 42137,
      lastError: null,
    });
  });

  it('stops the active remote HTTP transport when config changes to an invalid non-loopback bind', async () => {
    const registry = new PaneCommandRegistry();
    const configManager = new ConfigManagerStub(createEnabledRemoteConfig());
    const controller = new PaneRemoteTransportController(registry, configManager as never);
    activeControllers.push(controller);
    controller.startWatchingConfig();

    await controller.syncToConfig();
    expect(controller.getServer()).not.toBeNull();

    await configManager.updateRemoteDaemonConfig(createEnabledRemoteConfig({ listenHost: '0.0.0.0' }));
    await waitFor(() => controller.getServer() === null);
    await waitFor(() => remoteHostRuntimeStateStore.getState().status === 'error');
    expect(remoteHostRuntimeStateStore.getState()).toMatchObject({
      enabled: true,
      status: 'error',
      listenHost: '0.0.0.0',
      listenPort: 0,
    });
    expect(remoteHostRuntimeStateStore.getState().lastError).toContain('loopback');
  });
});
