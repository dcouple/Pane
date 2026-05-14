import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaneDaemonFrame } from '../../../shared/types/daemon';
import { PaneCommandRegistry } from './commandRegistry';
import { encodePaneDaemonFrame, PaneDaemonFrameDecoder } from './socketFraming';
import { PaneDaemonServer } from './server';

interface TestClient {
  socket: net.Socket;
  nextFrame(timeoutMs?: number): Promise<PaneDaemonFrame>;
}

const activeServers: PaneDaemonServer[] = [];
const activeSockets: net.Socket[] = [];
const activeTempDirs: string[] = [];

afterEach(async () => {
  for (const socket of activeSockets.splice(0)) {
    if (!socket.destroyed) {
      socket.destroy();
    }
  }

  for (const server of activeServers.splice(0)) {
    await server.stop();
  }

  for (const tempDir of activeTempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempAppDirectory(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-daemon-server-'));
  activeTempDirs.push(tempDir);
  return tempDir;
}

async function connectClient(server: PaneDaemonServer): Promise<TestClient> {
  const endpoint = server.getEndpoint();
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const client = net.createConnection(endpoint.path, () => resolve(client));
    client.once('error', reject);
  });

  activeSockets.push(socket);

  const decoder = new PaneDaemonFrameDecoder();
  const queuedFrames: PaneDaemonFrame[] = [];
  const waiters: Array<(frame: PaneDaemonFrame) => void> = [];

  socket.on('data', (chunk) => {
    const frames = decoder.push(chunk);
    for (const frame of frames) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        queuedFrames.push(frame);
      }
    }
  });

  return {
    socket,
    nextFrame(timeoutMs = 1000) {
      if (queuedFrames.length > 0) {
        return Promise.resolve(queuedFrames.shift() as PaneDaemonFrame);
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timed out waiting for Pane daemon frame'));
        }, timeoutMs);

        waiters.push((frame) => {
          clearTimeout(timeout);
          resolve(frame);
        });
      });
    },
  };
}

describe('PaneDaemonServer', () => {
  it('serves registered daemon commands over the local endpoint', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', async () => [{ id: 'session-1' }]);

    const server = new PaneDaemonServer(registry, createTempAppDirectory());
    activeServers.push(server);
    await server.start();

    const client = await connectClient(server);
    client.socket.write(encodePaneDaemonFrame({
      type: 'request',
      id: 1,
      channel: 'sessions:get-all',
      args: [],
    }));

    await expect(client.nextFrame()).resolves.toEqual({
      type: 'response',
      id: 1,
      ok: true,
      result: [{ id: 'session-1' }],
    });
  });

  it('returns structured errors for unknown daemon channels', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneDaemonServer(registry, createTempAppDirectory());
    activeServers.push(server);
    await server.start();

    const client = await connectClient(server);
    client.socket.write(encodePaneDaemonFrame({
      type: 'request',
      id: 2,
      channel: 'sessions:missing',
      args: [],
    }));

    await expect(client.nextFrame()).resolves.toEqual({
      type: 'response',
      id: 2,
      ok: false,
      error: {
        message: 'No Pane daemon command registered for channel "sessions:missing"',
        code: 'ERR_UNKNOWN_CHANNEL',
      },
    });
  });

  it('broadcasts daemon-owned events and filters Electron-only events', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneDaemonServer(registry, createTempAppDirectory());
    activeServers.push(server);
    await server.start();

    const client = await connectClient(server);
    server.getEventSink().send('session:created', { id: 'session-1' });

    await expect(client.nextFrame()).resolves.toEqual({
      type: 'event',
      channel: 'session:created',
      args: [{ id: 'session-1' }],
    });

    server.getEventSink().send('version:update-available', { version: '1.2.3' });
    await expect(client.nextFrame(100)).rejects.toThrow('Timed out waiting for Pane daemon frame');
  });

  it('cleans up the Unix socket file when stopped', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const registry = new PaneCommandRegistry();
    const server = new PaneDaemonServer(registry, createTempAppDirectory(), 'linux');
    await server.start();

    const socketPath = server.getEndpoint().path;
    expect(fs.existsSync(socketPath)).toBe(true);

    await server.stop();

    expect(fs.existsSync(socketPath)).toBe(false);
  });
});
