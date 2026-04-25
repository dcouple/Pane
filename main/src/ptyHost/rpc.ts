/**
 * Transport-agnostic framed-RPC helpers for the ptyHost boundary.
 *
 * This module intentionally does NOT import from `electron`; it works with
 * either `MessagePortMain` (Node-style `.on('message', ...)`) on the main side
 * or the renderer-side `MessagePort` (DOM-style `.onmessage`). The supervisor
 * (Chunk C) and `ptyHostMain` (Chunk B) wire the transport in.
 *
 * Responsibilities:
 * - Allocate monotonically-increasing request ids.
 * - Track pending `send()` promises in a `Map<id, { resolve, reject }>`.
 * - Resolve / reject pending promises when a `PtyHostResponse` lands via
 *   `handleResponse()`.
 * - Surface a minimal "poster" interface that the caller's transport can
 *   satisfy from either port flavour.
 */

import type {
  PtyHostRequest,
  PtyHostResponse,
  PtyHostSpawnError,
} from './types';

/**
 * Minimal poster contract; anything with a `postMessage(msg)` method fits.
 *
 * `MessagePortMain.postMessage(message: unknown)` and the renderer-side
 * `MessagePort.postMessage(message: unknown)` both satisfy this shape, as does
 * Electron's `UtilityProcess.postMessage(message, transfer?)` (the optional
 * `transfer` argument is compatible with a single-argument call).
 */
export interface RpcPoster {
  postMessage(message: unknown): void;
}

/**
 * Allocator for monotonically-increasing RPC correlation ids.
 *
 * The counter is per-instance so a supervisor and a host-side responder can
 * each own their own stream of ids without collision. Starts at 1 so `0` can
 * remain a sentinel for "not yet assigned" in callers that need one.
 */
export class RpcIdAllocator {
  private next = 1;

  allocate(): number {
    const id = this.next;
    this.next += 1;
    return id;
  }
}

/**
 * Resolver for a single pending RPC request.
 *
 * Returned by `trackPending()` so callers that need to handle cancellation
 * (e.g., supervisor restart rejecting every in-flight promise with
 * `PTY_HOST_RESTARTED`) can walk the map and reject entries without racing
 * the response handler.
 */
export type PendingResolver = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

/**
 * Tracks pending RPC requests and dispatches responses.
 *
 * Intentionally does not know about the transport; `send()` takes any poster
 * and `handleResponse()` takes already-decoded `PtyHostResponse` payloads.
 * Callers wire the transport: listen on the port, route inbound frames to
 * `handleResponse()` or to their own event-dispatch function based on shape.
 */
export class RpcDispatcher {
  private readonly pending = new Map<number, PendingResolver>();
  private readonly ids = new RpcIdAllocator();

  /**
   * Send a request and return a promise that resolves with the success payload
   * or rejects with an `Error` wrapping the `PtyHostSpawnError`.
   *
   * The caller provides the request minus its `id`; the dispatcher allocates
   * an id, stores the promise resolvers, and posts the fully-formed frame.
   */
  send<Req extends Omit<PtyHostRequest, 'id'>>(
    poster: RpcPoster,
    request: Req,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.ids.allocate();
      this.pending.set(id, { resolve, reject });
      const framed = { id, ...request } as PtyHostRequest;
      try {
        poster.postMessage(framed);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Dispatch an inbound `PtyHostResponse` to its waiting promise.
   *
   * Unknown ids are silently dropped; this can happen if the supervisor
   * rejected the pending map during restart and a late response lands.
   */
  handleResponse(response: PtyHostResponse): void {
    const entry = this.pending.get(response.id);
    if (!entry) {
      return;
    }
    this.pending.delete(response.id);
    if (response.ok) {
      entry.resolve(response.result);
    } else {
      entry.reject(toError(response.error));
    }
  }

  /**
   * Reject every pending request with the supplied error and clear the map.
   * Used by the supervisor on UtilityProcess exit / restart so any
   * `withLock()`-protected callers release their locks promptly.
   */
  rejectAll(error: Error): void {
    for (const [, entry] of this.pending) {
      entry.reject(error);
    }
    this.pending.clear();
  }

  /**
   * Inspect-only view of how many RPCs are in flight. Useful for telemetry
   * and tests; not part of the hot path.
   */
  pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * Shape-guard: narrow an arbitrary inbound frame into a `PtyHostResponse`.
 *
 * The supervisor may multiplex responses and events on the same port, so
 * callers need a cheap way to discriminate before routing. Returns `true` if
 * the frame has a numeric `id` and an `ok` boolean; the minimum shape a
 * response must satisfy.
 */
export function isPtyHostResponse(frame: unknown): frame is PtyHostResponse {
  if (typeof frame !== 'object' || frame === null) {
    return false;
  }
  const candidate = frame as { id?: unknown; ok?: unknown };
  return typeof candidate.id === 'number' && typeof candidate.ok === 'boolean';
}

/**
 * Convert a classified `PtyHostSpawnError` into a regular `Error`, preserving
 * the `code` on a `.code` property so main's Node-fallback classifier at
 * `AbstractCliManager.ts:604-717` can branch on it without re-parsing the
 * message string.
 */
function toError(spawnError: PtyHostSpawnError): Error {
  const err = new Error(spawnError.message) as Error & { code: PtyHostSpawnError['code'] };
  err.code = spawnError.code;
  return err;
}
