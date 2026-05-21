import type {
  RemoteDaemonEventEnvelope,
  RemoteDaemonHeartbeatPayload,
  RemotePaneConnectionProfile,
  RemotePaneConnectionStatus,
} from '../../../../shared/types/remoteDaemon';

type RemoteBrowserEvent =
  | { type: 'ready'; timestamp: string }
  | { type: 'heartbeat'; payload: RemoteDaemonHeartbeatPayload }
  | { type: 'daemon-event'; payload: RemoteDaemonEventEnvelope };

type RemoteBrowserEventListener = (event: RemoteBrowserEvent) => void;
type RemoteStatusListener = (status: RemoteBrowserConnectionState) => void;

export interface RemoteBrowserConnectionState {
  status: RemotePaneConnectionStatus;
  lastError: string | null;
  lastSeenAt: string | null;
}

interface InvokeSuccessPayload<T> {
  ok: true;
  result: T;
}

interface InvokeErrorPayload {
  ok: false;
  error?: {
    message?: string;
    code?: string;
  };
}

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const HEALTH_CHECK_ATTEMPTS = 5;
const INVOKE_ATTEMPTS = 4;
const REQUEST_RETRY_DELAY_MS = 2_000;
const RUNTIME_ID_STORAGE_KEY = 'pane.remotePwa.runtimeId';

export class RemoteDaemonBrowserClient {
  private abortController: AbortController | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private eventListeners = new Set<RemoteBrowserEventListener>();
  private statusListeners = new Set<RemoteStatusListener>();
  private state: RemoteBrowserConnectionState = {
    status: 'local',
    lastError: null,
    lastSeenAt: null,
  };

  constructor(private readonly profile: RemotePaneConnectionProfile) {}

  getState(): RemoteBrowserConnectionState {
    return { ...this.state };
  }

  onEvent(listener: RemoteBrowserEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: RemoteStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.getState());
    return () => this.statusListeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.clearReconnectTimer();
    this.abortController?.abort();
    this.abortController = new AbortController();
    this.reconnectAttempt = 0;
    this.setState({ status: 'connecting', lastError: null });

    await this.checkHealth(this.abortController.signal);
    this.openEventStream(this.abortController.signal);
  }

  disconnect(): void {
    this.clearReconnectTimer();
    this.abortController?.abort();
    this.abortController = null;
    this.reconnectAttempt = 0;
    this.setState({ status: 'local', lastError: null });
  }

  async invoke<T = unknown>(channel: string, args: unknown[] = []): Promise<T> {
    let lastError: unknown = null;
    const signal = getRequiredSignal(this.abortController);
    for (let attempt = 1; attempt <= INVOKE_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(this.endpoint('invoke'), {
          method: 'POST',
          headers: this.authHeaders({
            'Content-Type': 'application/json; charset=utf-8',
          }),
          body: JSON.stringify({ channel, args }),
          signal,
        });

        const payload = await response.json() as InvokeSuccessPayload<T> | InvokeErrorPayload;
        if (response.ok && payload.ok) {
          return payload.result;
        }

        const message = payload.ok
          ? `Remote request failed with ${response.status}`
          : payload.error?.message ?? 'Remote request failed';
        const error = new Error(message);
        if (!isRetryableResponse(response.status)) {
          throw new NonRetryableRemoteError(message);
        }
        lastError = error;
      } catch (error) {
        if (error instanceof NonRetryableRemoteError || signal.aborted) {
          throw error;
        }
        lastError = error;
      }

      if (attempt < INVOKE_ATTEMPTS) {
        await delay(REQUEST_RETRY_DELAY_MS * attempt, signal);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Remote request failed');
  }

  private async checkHealth(signal: AbortSignal): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(this.endpoint('health'), { signal, cache: 'no-store' });
        if (response.ok) {
          return;
        }
        lastError = new Error(`Remote health check failed with ${response.status}`);
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        lastError = error;
      }

      if (attempt < HEALTH_CHECK_ATTEMPTS) {
        await delay(REQUEST_RETRY_DELAY_MS * attempt, signal);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Remote health check failed');
  }

  private async openEventStream(signal: AbortSignal): Promise<void> {
    try {
      const response = await fetch(this.endpoint('events'), {
        headers: this.authHeaders(),
        signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Remote event stream failed with ${response.status}`);
      }

      this.reconnectAttempt = 0;
      this.setState({ status: 'connected', lastError: null, lastSeenAt: new Date().toISOString() });
      await this.consumeEventStream(response.body, signal);

      if (!signal.aborted) {
        throw new Error('Remote event stream ended');
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.scheduleReconnect(message);
    }
  }

  private async consumeEventStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseEvents(buffer);
        buffer = rest;

        for (const event of events) {
          this.handleSseEvent(event);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleSseEvent(event: ParsedSseEvent): void {
    if (event.event === 'heartbeat') {
      const payload = parseEventData<RemoteDaemonHeartbeatPayload>(event.data);
      this.setState({ lastSeenAt: payload.timestamp });
      this.emitEvent({ type: 'heartbeat', payload });
      return;
    }

    if (event.event === 'daemon-event') {
      const payload = parseEventData<RemoteDaemonEventEnvelope>(event.data);
      this.setState({ lastSeenAt: payload.timestamp });
      this.emitEvent({ type: 'daemon-event', payload });
      return;
    }

    if (event.event === 'ready') {
      const now = new Date().toISOString();
      this.setState({ status: 'connected', lastError: null, lastSeenAt: now });
      this.emitEvent({ type: 'ready', timestamp: now });
    }
  }

  private scheduleReconnect(message: string): void {
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.setState({ status: 'error', lastError: message });
      return;
    }

    this.reconnectAttempt += 1;
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempt - 1),
      MAX_RECONNECT_DELAY_MS,
    );
    this.setState({ status: 'reconnecting', lastError: message });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      const controller = new AbortController();
      this.abortController = controller;
      void this.openEventStream(controller.signal);
    }, delay);
  }

  private endpoint(path: 'events' | 'health' | 'invoke'): string {
    return `${this.profile.baseUrl}/${path}`;
  }

  private authHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.profile.token}`,
      'X-Pane-Remote-Runtime-Id': getRuntimeId(),
      'X-Pane-Remote-Client-Label': getClientLabel(),
      ...extraHeaders,
    };
  }

  private emitEvent(event: RemoteBrowserEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private setState(update: Partial<RemoteBrowserConnectionState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.statusListeners) {
      listener(this.getState());
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

interface ParsedSseEvent {
  event: string | null;
  data: string;
}

export function parseSseEvents(buffer: string): { events: ParsedSseEvent[]; rest: string } {
  const events: ParsedSseEvent[] = [];
  let rest = buffer;
  let boundary = rest.indexOf('\n\n');

  while (boundary !== -1) {
    const rawEvent = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const event = parseSseEvent(rawEvent);
    if (event) {
      events.push(event);
    }
    boundary = rest.indexOf('\n\n');
  }

  return { events, rest };
}

function parseSseEvent(rawEvent: string): ParsedSseEvent | null {
  const lines = rawEvent.split(/\r?\n/);
  let event: string | null = null;
  const data: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart());
    }
  }

  if (!event && data.length === 0) {
    return null;
  }

  return { event, data: data.join('\n') };
}

function parseEventData<T>(data: string): T {
  return JSON.parse(data) as T;
}

function getRuntimeId(): string {
  const existing = window.localStorage.getItem(RUNTIME_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const generated = window.crypto?.randomUUID?.() ?? `remote-pwa-${Date.now().toString(36)}`;
  window.localStorage.setItem(RUNTIME_ID_STORAGE_KEY, generated);
  return generated;
}

function getClientLabel(): string {
  const platform = navigator.platform || 'Browser';
  return `Pane PWA on ${platform}`;
}

function isRetryableResponse(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function getRequiredSignal(controller: AbortController | null): AbortSignal {
  if (!controller) {
    throw new DOMException('Aborted', 'AbortError');
  }
  return controller.signal;
}

class NonRetryableRemoteError extends Error {}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
