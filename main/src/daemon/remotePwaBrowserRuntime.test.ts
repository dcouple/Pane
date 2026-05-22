import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeRemoteConnectionCode } from '../../../frontend/src/remote/runtime/remoteProfile';
import {
  RemoteDaemonBrowserClient,
  parseSseEvents,
} from '../../../frontend/src/remote/runtime/remoteDaemonBrowserClient';
import { RemoteRuntimeAdapter } from '../../../frontend/src/remote/runtime/remoteRuntimeAdapter';
import type { PaneRemoteConnectionImportPayload } from '../../../shared/types/remoteDaemon';

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;

  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', originalNavigator);
  }

  (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
});

describe('Remote PWA browser runtime', () => {
  it('decodes and normalizes pane-remote connection codes', () => {
    const profile = decodeRemoteConnectionCode(createConnectionCode({
      baseUrl: 'https://host.example.test/app/',
      label: 'Remote Host',
      token: 'token-12345678',
    }));

    expect(profile.id).toBe('Remote Host:https://host.example.test/app:12345678');
    expect(profile.baseUrl).toBe('https://host.example.test/app');
    expect(profile.label).toBe('Remote Host');
    expect(profile.token).toBe('token-12345678');
    expect(profile.transport).toBe('http+sse');
  });

  it('rejects malformed connection codes', () => {
    expect(() => decodeRemoteConnectionCode('https://host.example.test')).toThrow(/pane-remote/);
    expect(() => decodeRemoteConnectionCode('pane-remote://not-json')).toThrow(/not valid/);
    expect(() => decodeRemoteConnectionCode(createConnectionCode({
      label: 'Remote Host',
      token: 'token',
      transport: 'websocket' as 'http+sse',
    }))).toThrow(/transport/);
  });

  it('parses ready, heartbeat, and daemon-event SSE frames', () => {
    const { events, rest } = parseSseEvents([
      'event: ready',
      'data: {"timestamp":"2026-05-19T00:00:00.000Z"}',
      '',
      'event: heartbeat',
      'data: {"timestamp":"2026-05-19T00:00:01.000Z"}',
      '',
      'event: daemon-event',
      'data: {"type":"terminal:output","payload":{"panelId":"panel-1","data":"ok"},"timestamp":"2026-05-19T00:00:02.000Z"}',
      '',
      'event: partial',
      'data: pending',
    ].join('\n'));

    expect(rest).toBe('event: partial\ndata: pending');
    expect(events).toEqual([
      { event: 'ready', data: '{"timestamp":"2026-05-19T00:00:00.000Z"}' },
      { event: 'heartbeat', data: '{"timestamp":"2026-05-19T00:00:01.000Z"}' },
      {
        event: 'daemon-event',
        data: '{"type":"terminal:output","payload":{"panelId":"panel-1","data":"ok"},"timestamp":"2026-05-19T00:00:02.000Z"}',
      },
    ]);
  });

  it('sends invoke requests without preflight-only auth headers', async () => {
    installBrowserGlobals();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: { projects: [] },
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new RemoteDaemonBrowserClient({
      id: 'profile-1',
      baseUrl: 'https://host.example.test',
      label: 'Remote Host',
      token: 'secret-token',
      transport: 'http+sse',
    });

    const result = await client.invoke('sessions:get-all-with-projects', []);

    expect(result).toEqual({ projects: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://host.example.test/invoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: JSON.stringify({
        channel: 'sessions:get-all-with-projects',
        args: [],
        token: 'secret-token',
        runtimeId: 'runtime-id-1',
        clientLabel: 'Pane PWA on TestOS',
      }),
    });
  });

  it('opens the event stream with browser auth metadata in query params', async () => {
    installBrowserGlobals();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"timestamp":"now"}\n\n'));
      },
    });
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
        status: 200,
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new RemoteDaemonBrowserClient({
      id: 'profile-1',
      baseUrl: 'https://host.example.test',
      label: 'Remote Host',
      token: 'secret-token',
      transport: 'http+sse',
    });

    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://host.example.test/health', {
      signal: expect.any(AbortSignal) as AbortSignal,
      cache: 'no-store',
    });

    const eventUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(eventUrl.origin).toBe('https://host.example.test');
    expect(eventUrl.pathname).toBe('/events');
    expect(eventUrl.searchParams.get('access_token')).toBe('secret-token');
    expect(eventUrl.searchParams.get('runtime_id')).toBe('runtime-id-1');
    expect(eventUrl.searchParams.get('client_label')).toBe('Pane PWA on TestOS');
    expect(fetchMock.mock.calls[1][1]).toEqual({
      signal: expect.any(AbortSignal),
    });

    client.disconnect();
  });

  it('uses native EventSource for browser SSE when available', async () => {
    installBrowserGlobals();
    const MockEventSource = installMockEventSource();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new RemoteDaemonBrowserClient({
      id: 'profile-1',
      baseUrl: 'https://host.example.test',
      label: 'Remote Host',
      token: 'secret-token',
      transport: 'http+sse',
    });
    const receivedEvents: unknown[] = [];
    client.onEvent((event) => receivedEvents.push(event));

    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://host.example.test/health', {
      signal: expect.any(AbortSignal) as AbortSignal,
      cache: 'no-store',
    });

    const preflightUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(preflightUrl.origin).toBe('https://host.example.test');
    expect(preflightUrl.pathname).toBe('/events');
    expect(preflightUrl.searchParams.get('access_token')).toBe('secret-token');
    expect(preflightUrl.searchParams.get('runtime_id')).toBe('runtime-id-1');
    expect(preflightUrl.searchParams.get('client_label')).toBe('Pane PWA on TestOS');
    expect(preflightUrl.searchParams.get('auth_check')).toBe('1');
    expect(fetchMock.mock.calls[1][1]).toEqual({
      signal: expect.any(AbortSignal),
      cache: 'no-store',
    });
    expect(MockEventSource.instances).toHaveLength(1);

    const eventSource = MockEventSource.instances[0];
    const eventUrl = new URL(eventSource.url);
    expect(eventUrl.origin).toBe('https://host.example.test');
    expect(eventUrl.pathname).toBe('/events');
    expect(eventUrl.searchParams.get('access_token')).toBe('secret-token');
    expect(eventUrl.searchParams.get('runtime_id')).toBe('runtime-id-1');
    expect(eventUrl.searchParams.get('client_label')).toBe('Pane PWA on TestOS');

    eventSource.open();
    eventSource.emit('ready', '{"timestamp":"2026-05-19T00:00:00.000Z"}');
    eventSource.emit('heartbeat', '{"timestamp":"2026-05-19T00:00:01.000Z"}');
    eventSource.emit(
      'daemon-event',
      '{"channel":"terminal:output","args":[{"panelId":"panel-1","data":"ok"}],"timestamp":"2026-05-19T00:00:02.000Z"}',
    );

    expect(client.getState().status).toBe('connected');
    expect(client.getState().lastSeenAt).toBe('2026-05-19T00:00:02.000Z');
    expect(receivedEvents).toMatchObject([
      { type: 'ready' },
      { type: 'heartbeat', payload: { timestamp: '2026-05-19T00:00:01.000Z' } },
      {
        type: 'daemon-event',
        payload: {
          channel: 'terminal:output',
          args: [{ panelId: 'panel-1', data: 'ok' }],
          timestamp: '2026-05-19T00:00:02.000Z',
        },
      },
    ]);

    client.disconnect();
    expect(eventSource.close).toHaveBeenCalledTimes(1);
  });

  it('stops reconnecting when a native event stream preflight is rejected', async () => {
    installBrowserGlobals();
    const MockEventSource = installMockEventSource();
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response(JSON.stringify({
        ok: false,
        error: {
          message: 'Remote daemon bearer token is invalid',
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 403,
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new RemoteDaemonBrowserClient({
      id: 'profile-1',
      baseUrl: 'https://host.example.test',
      label: 'Remote Host',
      token: 'secret-token',
      transport: 'http+sse',
    });

    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(MockEventSource.instances).toHaveLength(0);
    expect(client.getState()).toMatchObject({
      status: 'error',
      lastError: expect.stringContaining('connection code is not accepted'),
    });
  });

  it('does not retry invoke requests when the host rejects the connection code', async () => {
    installBrowserGlobals();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: {
        message: 'Remote daemon bearer token is invalid',
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 403,
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new RemoteDaemonBrowserClient({
      id: 'profile-1',
      baseUrl: 'https://host.example.test',
      label: 'Remote Host',
      token: 'secret-token',
      transport: 'http+sse',
    });

    await expect(client.invoke('sessions:get-all-with-projects', [])).rejects.toThrow(
      /connection code is not accepted.+Remote daemon bearer token is invalid/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows a Safari Tailscale hint when health checks fail before HTTP', async () => {
    vi.useFakeTimers();
    try {
      installBrowserGlobals();
      const fetchMock = vi.fn(async () => {
        throw new TypeError('Load failed');
      });
      globalThis.fetch = fetchMock as typeof fetch;

      const client = new RemoteDaemonBrowserClient({
        id: 'profile-1',
        baseUrl: 'https://host.tailnet.ts.net',
        label: 'Remote Host',
        token: 'secret-token',
        transport: 'http+sse',
      });

      const connect = client.connect().catch((error: unknown) => error);
      await vi.runAllTimersAsync();

      const error = await connect;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        /Safari could not reach the Tailscale host host\.tailnet\.ts\.net.+iCloud Private Relay/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes remote sidebar mutations through session daemon commands', async () => {
    installBrowserGlobals();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { channel?: string };
      return new Response(JSON.stringify({
        ok: true,
        result: body.channel === 'sessions:toggle-favorite'
          ? { success: true, data: { isFavorite: true } }
          : { success: true },
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const adapter = new RemoteRuntimeAdapter({
      id: 'profile-1',
      baseUrl: 'https://host.example.test',
      label: 'Remote Host',
      token: 'secret-token',
      transport: 'http+sse',
    });

    await expect(adapter.toggleFavorite('session-1')).resolves.toEqual({ isFavorite: true });
    await expect(adapter.archiveSession('session-1')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(firstBody).toMatchObject({
      channel: 'sessions:toggle-favorite',
      args: ['session-1'],
      token: 'secret-token',
      runtimeId: 'runtime-id-1',
      clientLabel: 'Pane PWA on TestOS',
    });
    expect(secondBody).toMatchObject({
      channel: 'sessions:delete',
      args: ['session-1'],
      token: 'secret-token',
      runtimeId: 'runtime-id-1',
      clientLabel: 'Pane PWA on TestOS',
    });
  });

  it('routes remote pane creation through project and session daemon commands', async () => {
    installBrowserGlobals();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { channel?: string };
      const dataByChannel: Record<string, unknown> = {
        'projects:list-branches': [{
          name: 'origin/main',
          isCurrent: false,
          hasWorktree: false,
          isRemote: true,
        }],
        'projects:detect-branch': 'main',
        'sessions:create': { jobId: 'job-1' },
      };
      return new Response(JSON.stringify({
        ok: true,
        result: { success: true, data: dataByChannel[body.channel ?? ''] },
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const adapter = new RemoteRuntimeAdapter({
      id: 'profile-1',
      baseUrl: 'https://host.example.test',
      label: 'Remote Host',
      token: 'secret-token',
      transport: 'http+sse',
    });

    await expect(adapter.listProjectBranches(42)).resolves.toEqual([{
      name: 'origin/main',
      isCurrent: false,
      hasWorktree: false,
      isRemote: true,
    }]);
    await expect(adapter.detectProjectBranch('/repo')).resolves.toBe('main');
    await expect(adapter.createSession({
      prompt: '',
      worktreeTemplate: 'main',
      count: 1,
      toolType: 'none',
      permissionMode: 'ignore',
      projectId: 42,
      isMainRepo: false,
      baseBranch: 'origin/main',
    })).resolves.toEqual({ jobId: 'job-1' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = fetchMock.mock.calls.map(call => JSON.parse((call[1] as RequestInit).body as string));
    expect(bodies[0]).toMatchObject({
      channel: 'projects:list-branches',
      args: ['42'],
    });
    expect(bodies[1]).toMatchObject({
      channel: 'projects:detect-branch',
      args: ['/repo'],
    });
    expect(bodies[2]).toMatchObject({
      channel: 'sessions:create',
      args: [{
        prompt: '',
        worktreeTemplate: 'main',
        count: 1,
        toolType: 'none',
        permissionMode: 'ignore',
        projectId: 42,
        isMainRepo: false,
        baseBranch: 'origin/main',
      }],
    });
  });
});

function createConnectionCode(overrides: Partial<PaneRemoteConnectionImportPayload> = {}): string {
  const payload: PaneRemoteConnectionImportPayload = {
    v: 1,
    label: 'Remote Host',
    baseUrl: 'https://host.example.test',
    token: 'token',
    transport: 'http+sse',
    ...overrides,
  };

  return `pane-remote://${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function installBrowserGlobals(): void {
  const values = new Map<string, string>();
  (globalThis as typeof globalThis & { window?: unknown }).window = {
    crypto: {
      randomUUID: () => 'runtime-id-1',
    },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      platform: 'TestOS',
    },
  });
}

function installMockEventSource(): { instances: MockEventSourceInstance[] } {
  const instances: MockEventSourceInstance[] = [];

  class MockEventSource implements Partial<EventSource> {
    readonly url: string;
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    readonly close = vi.fn();
    private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

    constructor(url: string | URL) {
      this.url = String(url);
      instances.push(this as MockEventSourceInstance);
    }

    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      this.listeners.get(type)?.delete(listener);
    }

    open(): void {
      this.onopen?.({ type: 'open' } as Event);
    }

    emit(type: string, data: string): void {
      const event = { type, data } as MessageEvent<string>;
      for (const listener of this.listeners.get(type) ?? []) {
        if (typeof listener === 'function') {
          listener(event);
        } else {
          listener.handleEvent(event);
        }
      }
    }
  }

  Object.defineProperty(globalThis, 'EventSource', {
    configurable: true,
    writable: true,
    value: MockEventSource,
  });
  return { instances };
}

interface MockEventSourceInstance extends EventSource {
  url: string;
  close: ReturnType<typeof vi.fn>;
  open(): void;
  emit(type: string, data: string): void;
}
