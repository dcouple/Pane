/**
 * UtilityProcess entry for the ptyHost.
 *
 * This file runs inside an Electron `UtilityProcess` (forked by the main-side
 * `PtyHostSupervisor` in Chunk C). It owns the PTY handles and executes spawn,
 * write, resize, kill, pause, and resume requests on behalf of main. Bytes and
 * exit events stream back over the same port as unsolicited `PtyHostEvent`
 * frames.
 *
 * Self-contained by design:
 * - No imports from Pane's main services (Logger, ConfigManager, shell
 *   detection, wslUtils). The UtilityProcess knows nothing about Pane's
 *   configuration; all policy stays on the main side.
 * - `@lydell/node-pty` loads with the same ABI as main because UtilityProcess
 *   shares Electron's Node runtime (`package.json:55, 115-121`).
 *
 * Wire protocol (matches `types.ts`):
 * - The main side sends a single `{ type: 'init' }` message on Electron's `parentPort`
 *   with one `MessagePortMain` attached via `transferList`. That port is the
 *   sole bidirectional channel thereafter.
 * - Inbound frames on the port are either:
 *   - `{ type: 'heartbeat-ping' }` (raw event, no `id`) — reply with
 *     `{ type: 'heartbeat-pong' }`.
 *   - `PtyHostRequest` (has numeric `id` + string `method`) — dispatch and
 *     reply with a matching `PtyHostResponse`.
 * - Outbound frames are `PtyHostResponse` (with `id`) or `PtyHostEvent`
 *   (without `id`).
 *
 * Port lifetime:
 * - The port is stored in a module-scoped variable. Closure locals would let
 *   GC close the channel (see plan gotchas line 323, 736, 963).
 */

import { randomUUID } from 'node:crypto';

// node-pty's CommonJS export shape matches what main uses at
// `terminalPanelManager.ts:1`. We use a typed `require` here because this
// UtilityProcess entry is deliberately self-contained; importing via
// `import * as pty` would couple to main's module graph.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pty = require('@lydell/node-pty') as typeof import('@lydell/node-pty');

// Electron exposes UtilityProcess parentPort on `process.parentPort` in this
// runtime. Keep a fallback to `require('electron').parentPort` for forward
// compatibility without depending on a named export that Electron's main
// process type surface does not expose.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electron = require('electron') as { parentPort?: unknown };

import type {
  PtyHostRequest,
  PtyHostResponse,
  PtyHostSpawnError,
  PtyHostSpawnOpts,
} from './types';

/**
 * Minimal subset of `IPty` we use. Lifted from `@lydell/node-pty`'s
 * `node-pty.d.ts` so this file does not have to type-require the whole module
 * surface. Matches the methods called in `terminalPanelManager.ts`.
 */
interface HostPty {
  readonly pid: number;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

/** Port handoff message shape; the supervisor posts exactly this on init. */
interface InitMessage {
  type: 'init';
}

/** Raw heartbeat frame; NOT an RPC request (no `id`, no `method`). */
interface HeartbeatPing {
  type: 'heartbeat-ping';
}

/**
 * Minimal typing for the MessagePortMain we receive from Electron's `parentPort`.
 * We intentionally avoid importing `electron`'s types here so this module can
 * be reasoned about in isolation. Electron's `MessagePortMain` extends
 * `NodeEventEmitter` and exposes `.start()`, `.postMessage()`, and
 * `.on('message', listener)` — exactly the shape below.
 */
interface HostPort {
  start(): void;
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown; ports: unknown[] }) => void): void;
}

// Module-scoped port and PTY map. Both MUST live at module scope: the port
// would otherwise be collected and close the channel; the PTY map must
// survive across every inbound RPC.
let rpcPort: HostPort | null = null;
const ptyMap = new Map<string, HostPty>();

/**
 * Top-level bootstrap.
 *
 * Electron's `parentPort` is provided by the UtilityProcess runtime. We register a
 * one-shot listener for the init message; after that, all traffic flows over
 * the attached `MessagePortMain`.
 */
function bootstrap(): void {
  const parent = (
    (process as unknown as { parentPort?: unknown }).parentPort ?? electron.parentPort
  ) as (HostPort & { once: HostPort['on'] }) | undefined;
  if (!parent) {
    console.error('[ptyHost] parentPort is not available; exiting');
    process.exit(1);
    return;
  }

  parent.once('message', (event: { data: unknown; ports: unknown[] }) => {
    if (!isInitMessage(event.data)) {
      console.error('[ptyHost] first parentPort message was not { type: "init" }; exiting', event.data);
      process.exit(1);
      return;
    }
    const [port] = event.ports as HostPort[];
    if (!port) {
      console.error('[ptyHost] init message arrived without a MessagePort; exiting');
      process.exit(1);
      return;
    }
    rpcPort = port;
    // MessagePortMain queues inbound messages until `.start()` is called; the
    // first miss manifests as silent hang, so we must call it before adding
    // the listener to minimize the chance of a missed early frame.
    port.start();
    port.on('message', (message) => {
      handleInboundFrame(message.data);
    });
    parent.postMessage({ type: 'host-ready' });
    console.log('[ptyHost] ready; RPC port attached');
  });
}

/**
 * Route an inbound port frame to the right handler.
 *
 * Heartbeat frames are distinguished by `type === 'heartbeat-ping'`; RPC
 * requests carry `id` (number) and `method` (string). Everything else is
 * logged and dropped.
 */
function handleInboundFrame(frame: unknown): void {
  if (isHeartbeatPing(frame)) {
    if (rpcPort) {
      rpcPort.postMessage({ type: 'heartbeat-pong' });
    }
    return;
  }
  if (isPtyHostRequest(frame)) {
    handleRequest(frame).catch((err: unknown) => {
      console.error('[ptyHost] unhandled error in request dispatch', err);
    });
    return;
  }
  console.error('[ptyHost] received unknown frame, dropping', frame);
}

/**
 * Dispatch one RPC request. Never throws; always posts a response.
 */
async function handleRequest(request: PtyHostRequest): Promise<void> {
  switch (request.method) {
    case 'spawn':
      handleSpawn(request.id, request.args);
      return;
    case 'write':
      handleWrite(request.id, request.args.ptyId, request.args.data);
      return;
    case 'resize':
      handleResize(request.id, request.args.ptyId, request.args.cols, request.args.rows);
      return;
    case 'kill':
      handleKill(request.id, request.args.ptyId, request.args.signal);
      return;
    case 'ack':
      // Flow-control + pause/resume live on the main side; `ack` is a stub on
      // the host. Reply `ok` so callers resolve.
      respondOk(request.id, undefined);
      return;
    case 'pause':
      handlePause(request.id, request.args.ptyId);
      return;
    case 'resume':
      handleResume(request.id, request.args.ptyId);
      return;
    default: {
      // Exhaustiveness guard: if a new method is added to `PtyHostRequest`
      // without updating this switch, TypeScript will flag `_unreachable`.
      const _unreachable: never = request;
      void _unreachable;
      return;
    }
  }
}

function handleSpawn(id: number, opts: PtyHostSpawnOpts): void {
  const ptyId = randomUUID();
  let ptyProcess: HostPty;
  try {
    // Cast via `unknown` to keep the HostPty shape narrow; node-pty's own
    // `IPty` is a superset we don't need here.
    ptyProcess = pty.spawn(opts.shell, opts.args, {
      name: opts.name ?? 'xterm-256color',
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: opts.env,
    }) as unknown as HostPty;
  } catch (err) {
    const classified = classifySpawnError(err);
    console.error(`[ptyHost] spawn failed: code=${classified.code} message=${classified.message}`);
    respondErr(id, classified);
    return;
  }

  ptyMap.set(ptyId, ptyProcess);

  ptyProcess.onData((data) => {
    if (!rpcPort) {
      return;
    }
    rpcPort.postMessage({ type: 'data', ptyId, data });
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    if (rpcPort) {
      // Forward `{exitCode, signal}` verbatim including undefined → null.
      // `AbstractCliManager.ts:781-795` branches on the raw signal number so
      // we must not normalize to a string name.
      rpcPort.postMessage({
        type: 'exit',
        ptyId,
        exitCode: exitCode ?? null,
        signal: signal ?? null,
      });
    }
    ptyMap.delete(ptyId);
  });

  console.log(`[ptyHost] spawned ptyId=${ptyId} pid=${ptyProcess.pid} shell=${opts.shell}`);
  respondOk(id, { ptyId, pid: ptyProcess.pid });
}

function handleWrite(id: number, ptyId: string, data: string): void {
  const p = ptyMap.get(ptyId);
  if (!p) {
    respondErr(id, { code: 'OTHER', message: `unknown ptyId: ${ptyId}` });
    return;
  }
  try {
    p.write(data);
    respondOk(id, undefined);
  } catch (err) {
    respondErr(id, { code: 'OTHER', message: errorMessage(err) });
  }
}

function handleResize(id: number, ptyId: string, cols: number, rows: number): void {
  const p = ptyMap.get(ptyId);
  if (!p) {
    respondErr(id, { code: 'OTHER', message: `unknown ptyId: ${ptyId}` });
    return;
  }
  try {
    p.resize(cols, rows);
    respondOk(id, undefined);
  } catch (err) {
    respondErr(id, { code: 'OTHER', message: errorMessage(err) });
  }
}

function handleKill(id: number, ptyId: string, signal: NodeJS.Signals | undefined): void {
  const p = ptyMap.get(ptyId);
  if (!p) {
    respondErr(id, { code: 'OTHER', message: `unknown ptyId: ${ptyId}` });
    return;
  }
  try {
    // Do NOT pre-delete from the map; `onExit` is the single source of truth
    // for removal (plan task 2 gotcha).
    p.kill(signal);
    respondOk(id, undefined);
  } catch (err) {
    respondErr(id, { code: 'OTHER', message: errorMessage(err) });
  }
}

function handlePause(id: number, ptyId: string): void {
  const p = ptyMap.get(ptyId);
  if (!p) {
    respondErr(id, { code: 'OTHER', message: `unknown ptyId: ${ptyId}` });
    return;
  }
  try {
    p.pause();
    respondOk(id, undefined);
  } catch (err) {
    respondErr(id, { code: 'OTHER', message: errorMessage(err) });
  }
}

function handleResume(id: number, ptyId: string): void {
  const p = ptyMap.get(ptyId);
  if (!p) {
    respondErr(id, { code: 'OTHER', message: `unknown ptyId: ${ptyId}` });
    return;
  }
  try {
    p.resume();
    respondOk(id, undefined);
  } catch (err) {
    respondErr(id, { code: 'OTHER', message: errorMessage(err) });
  }
}

/**
 * Classify a spawn error into one of the four buckets main's Node-fallback
 * path at `AbstractCliManager.ts:604-717, 781-795` recognizes. Mirrors the
 * substring checks at lines 717-722.
 */
function classifySpawnError(err: unknown): PtyHostSpawnError {
  const message = errorMessage(err);
  const errObj = err as { code?: unknown; errno?: unknown } | undefined;
  const code = typeof errObj?.code === 'string' ? errObj.code : undefined;

  // Windows error 193 ("not a valid Win32 application"): `code === 'UNKNOWN'`
  // with `errno === -4094` historically, but the classifier in AbstractCli
  // matches on message substrings, so we do the same.
  if (
    message.includes('error code: 193') ||
    message.includes('not a valid Win32 application') ||
    (code === 'UNKNOWN' && (errObj?.errno === 193 || errObj?.errno === -193))
  ) {
    return { code: 'E193', message };
  }

  // ENOENT: binary not found on PATH. Covers both Node's native `code` field
  // and the message-string variants surfaced by conpty / node-pty.
  if (
    code === 'ENOENT' ||
    message.includes('ENOENT') ||
    message.includes('No such file or directory') ||
    message.includes('is not recognized')
  ) {
    return { code: 'ENOENT', message };
  }

  // Shebang / posix_spawn interpreter failures. The message substrings here
  // match the shebang case at `AbstractCliManager.ts:717-722` (`env: node:`
  // etc.) plus the `posix_spawn` text surfaced by darwin when the kernel
  // can't read the interpreter line.
  if (
    message.includes('posix_spawn') ||
    message.includes('env: node:') ||
    message.toLowerCase().includes('shebang')
  ) {
    return { code: 'SHEBANG', message };
  }

  return { code: 'OTHER', message };
}

function respondOk(id: number, result: { ptyId: string; pid: number } | undefined): void {
  if (!rpcPort) {
    return;
  }
  const frame: PtyHostResponse = result
    ? { id, ok: true, result }
    : { id, ok: true, result: undefined };
  rpcPort.postMessage(frame);
}

function respondErr(id: number, error: PtyHostSpawnError): void {
  if (!rpcPort) {
    return;
  }
  const frame: PtyHostResponse = { id, ok: false, error };
  rpcPort.postMessage(frame);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isInitMessage(frame: unknown): frame is InitMessage {
  if (typeof frame !== 'object' || frame === null) {
    return false;
  }
  const candidate = frame as { type?: unknown };
  return candidate.type === 'init';
}

function isHeartbeatPing(frame: unknown): frame is HeartbeatPing {
  if (typeof frame !== 'object' || frame === null) {
    return false;
  }
  const candidate = frame as { type?: unknown };
  return candidate.type === 'heartbeat-ping';
}

/**
 * Cheap structural check; mirrors the shape guard in `rpc.ts` but lives here
 * so this file stays self-contained relative to any main-side helpers.
 */
function isPtyHostRequest(frame: unknown): frame is PtyHostRequest {
  if (typeof frame !== 'object' || frame === null) {
    return false;
  }
  const candidate = frame as { id?: unknown; method?: unknown; args?: unknown };
  return (
    typeof candidate.id === 'number' &&
    typeof candidate.method === 'string' &&
    typeof candidate.args === 'object' &&
    candidate.args !== null
  );
}

bootstrap();
