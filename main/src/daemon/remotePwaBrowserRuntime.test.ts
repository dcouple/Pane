import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeRemoteConnectionCode } from '../../../frontend/src/remote/runtime/remoteProfile';
import {
  RemoteDaemonBrowserClient,
  parseSseEvents,
} from '../../../frontend/src/remote/runtime/remoteDaemonBrowserClient';
import type { PaneRemoteConnectionImportPayload } from '../../../shared/types/remoteDaemon';

const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;

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
  };

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      platform: 'TestOS',
    },
  });
}
