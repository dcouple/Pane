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

  it('sends invoke requests with auth and browser runtime headers', async () => {
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
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Pane-Remote-Client-Label': 'Pane PWA on TestOS',
        'X-Pane-Remote-Runtime-Id': 'runtime-id-1',
      },
      body: JSON.stringify({ channel: 'sessions:get-all-with-projects', args: [] }),
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
  };

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      platform: 'TestOS',
    },
  });
}
