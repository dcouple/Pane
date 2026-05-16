import fs from 'fs';
import net from 'net';
import path from 'path';
import type { PaneEventSink } from '../core/eventSink';
import type { PaneCommandRegistry } from './commandRegistry';
import { encodePaneDaemonFrame, PaneDaemonFrameDecoder } from './socketFraming';
import { getPaneDaemonEndpoint, type PaneDaemonEndpoint } from './socketPath';
import type {
  PaneDaemonErrorResponseFrame,
  PaneDaemonRequestFrame,
  PaneDaemonSuccessResponseFrame,
} from '../../../shared/types/daemon';

const DAEMON_EVENT_PREFIXES = [
  'archive:',
  'folder:',
  'panel:',
  'project:',
  'resource-monitor:',
  'session:',
  'sessions:',
  'terminal:',
] as const;

const DAEMON_EVENT_EXACT_CHANNELS = new Set<string>([
  'git-status-loading',
  'git-status-updated',
  'logs:output',
  'process:ended',
  'project-script-changed',
  'project-script-closing',
  'session-log',
  'session-logs-cleared',
  'script-closing',
  'script-session-changed',
]);

function isPaneDaemonEventChannel(channel: string): boolean {
  if (DAEMON_EVENT_EXACT_CHANNELS.has(channel)) {
    return true;
  }

  return DAEMON_EVENT_PREFIXES.some((prefix) => channel.startsWith(prefix));
}

interface ConnectedPaneDaemonClient {
  socket: net.Socket;
  decoder: PaneDaemonFrameDecoder;
}

export class PaneDaemonServer {
  private server: net.Server | null = null;
  private readonly clients = new Map<string, ConnectedPaneDaemonClient>();
  private readonly endpoint: PaneDaemonEndpoint;
  private nextClientId = 1;

  private readonly daemonEventSink: PaneEventSink = {
    send: (channel: string, ...args: unknown[]) => {
      if (!isPaneDaemonEventChannel(channel) || this.clients.size === 0) {
        return;
      }

      const encodedFrame = encodePaneDaemonFrame({
        type: 'event',
        channel,
        args,
      });

      for (const [clientId, client] of this.clients) {
        this.writeFrame(clientId, client.socket, encodedFrame);
      }
    },
  };

  constructor(
    private readonly commandRegistry: PaneCommandRegistry,
    appDirectory: string,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.endpoint = getPaneDaemonEndpoint(appDirectory, platform);
  }

  getEndpoint(): PaneDaemonEndpoint {
    return this.endpoint;
  }

  getEventSink(): PaneEventSink {
    return this.daemonEventSink;
  }

  hasSubscribers(): boolean {
    return this.clients.size > 0;
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Pane daemon server is already running');
    }

    if (this.endpoint.transport === 'unix') {
      fs.mkdirSync(path.dirname(this.endpoint.path), { recursive: true });
      if (fs.existsSync(this.endpoint.path)) {
        const unixSocketStatus = await probeUnixSocketPath(this.endpoint.path);
        if (unixSocketStatus === 'active') {
          throw new Error(`Pane daemon server is already listening on ${this.endpoint.path}`);
        }

        fs.unlinkSync(this.endpoint.path);
      }
    }

    const server = net.createServer((socket) => {
      this.attachClient(socket);
    });

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        server.removeListener('listening', handleListening);
        this.server = null;
        reject(error);
      };

      const handleListening = () => {
        server.removeListener('error', handleError);
        resolve();
      };

      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(this.endpoint.path);
    });

    server.on('error', (error) => {
      console.error('[Pane daemon] Server error:', error);
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;

    for (const clientId of [...this.clients.keys()]) {
      this.dropClient(clientId);
    }

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    if (this.endpoint.transport === 'unix' && fs.existsSync(this.endpoint.path)) {
      fs.unlinkSync(this.endpoint.path);
    }
  }

  private attachClient(socket: net.Socket): void {
    const clientId = String(this.nextClientId++);
    const client: ConnectedPaneDaemonClient = {
      socket,
      decoder: new PaneDaemonFrameDecoder(),
    };

    this.clients.set(clientId, client);

    socket.on('data', (chunk) => {
      try {
        const frames = client.decoder.push(chunk);
        for (const frame of frames) {
          if (frame.type !== 'request') {
            socket.destroy(new Error(`Pane daemon clients must send request frames, received "${frame.type}"`));
            return;
          }

          void this.handleRequest(socket, frame);
        }
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.on('error', () => {
      this.dropClient(clientId);
    });

    socket.on('close', () => {
      this.clients.delete(clientId);
      try {
        client.decoder.finish();
      } catch {
        // The client closed mid-frame. Treat it as a disconnected subscriber.
      }
    });
  }

  private dropClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    this.clients.delete(clientId);
    if (!client.socket.destroyed) {
      client.socket.destroy();
    }
  }

  private async handleRequest(socket: net.Socket, frame: PaneDaemonRequestFrame): Promise<void> {
    const response = await this.buildResponseFrame(frame);

    if (!socket.destroyed) {
      const clientId = [...this.clients.entries()].find(([, client]) => client.socket === socket)?.[0];
      const encodedFrame = encodePaneDaemonFrame(response);
      if (clientId) {
        this.writeFrame(clientId, socket, encodedFrame);
      } else {
        socket.write(encodedFrame);
      }
    }
  }

  private writeFrame(clientId: string, socket: net.Socket, encodedFrame: string): void {
    try {
      const accepted = socket.write(encodedFrame);
      if (!accepted) {
        this.dropClient(clientId);
      }
    } catch {
      this.dropClient(clientId);
    }
  }

  private async buildResponseFrame(
    frame: PaneDaemonRequestFrame,
  ): Promise<PaneDaemonSuccessResponseFrame | PaneDaemonErrorResponseFrame> {
    try {
      const result = await this.commandRegistry.invoke(frame.channel, frame.args);
      return {
        type: 'response',
        id: frame.id,
        ok: true,
        result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes('No Pane daemon command registered')
        ? 'ERR_UNKNOWN_CHANNEL'
        : 'ERR_DAEMON_REQUEST_FAILED';

      return {
        type: 'response',
        id: frame.id,
        ok: false,
        error: {
          message,
          code,
        },
      };
    }
  }
}

async function probeUnixSocketPath(socketPath: string): Promise<'active' | 'stale'> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);

    const settle = (result: 'active' | 'stale') => {
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      resolve(result);
    };

    socket.once('connect', () => settle('active'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT' || error.code === 'ENOTSOCK') {
        settle('stale');
        return;
      }

      reject(error);
    });
  });
}
