/**
 * Main-internal RPC DTOs for the ptyHost UtilityProcess boundary.
 *
 * These types are NOT re-exported via `shared/types/panels.ts` because the
 * renderer only interacts with the ptyHost through the typed `electronAPI.ptyHost`
 * surface (added in Chunk C). Only the main process and the UtilityProcess entry
 * (`ptyHostMain.ts`) share structural access to these shapes.
 *
 * Locked decisions this file encodes:
 * - `cwd: string | undefined` is intentional; preserves the WSL contract at
 *   `terminalPanelManager.ts:194-198` where `wsl.exe` ignores cwd and the `cd`
 *   is baked into the bash command.
 * - `exit` events MUST carry `exitCode: number | null` and `signal: number | null`
 *   verbatim; SIGSEGV/SIGABRT/SIGBUS detection at `AbstractCliManager.ts:781-795`
 *   depends on the raw signal number surviving RPC serialization.
 */

export interface PtyHostSpawnOpts {
  shell: string;
  args: string[];
  /**
   * Working directory. May be `undefined` for WSL spawns; `wsl.exe` ignores cwd
   * and the `cd` is baked into the bash command. Do not default to a truthy value.
   */
  cwd: string | undefined;
  cols: number;
  rows: number;
  env: Record<string, string>;
  /** Terminal type name; defaults to `xterm-256color` in the host when omitted. */
  name?: string;
}

/**
 * Discriminated union over the seven RPC methods. Every request carries a
 * monotonically-increasing `id` so the caller can correlate the matching
 * `PtyHostResponse`.
 *
 * `pause` / `resume` are the async across-seam counterparts of
 * `IPty.pause()` / `IPty.resume()`. Main's flow-control bookkeeping
 * (`flowControl.ts`) posts these when the high / low watermarks are crossed.
 * `ack` is retained in the union for forward-compat but is a no-op on the
 * host side — flow-control state lives entirely on the main side.
 */
export type PtyHostRequest =
  | { id: number; method: 'spawn'; args: PtyHostSpawnOpts }
  | { id: number; method: 'write'; args: { ptyId: string; data: string } }
  | { id: number; method: 'resize'; args: { ptyId: string; cols: number; rows: number } }
  | { id: number; method: 'kill'; args: { ptyId: string; signal?: NodeJS.Signals } }
  | { id: number; method: 'ack'; args: { ptyId: string; bytes: number } }
  | { id: number; method: 'pause'; args: { ptyId: string } }
  | { id: number; method: 'resume'; args: { ptyId: string } };

/**
 * Classified spawn error.
 *
 * Main's Node-fallback loop at `AbstractCliManager.ts:604-717` branches on
 * `code` to decide whether to retry with the Node-executable path:
 * - `ENOENT`: binary not found on PATH.
 * - `E193`: Windows error 193; npm-bin-stub (non-PE-exec) case.
 * - `SHEBANG`: spawn failed because the kernel couldn't exec the shebang line.
 * - `OTHER`: classifier did not recognize the failure; no retry.
 */
export type PtyHostSpawnError = {
  code: 'ENOENT' | 'E193' | 'SHEBANG' | 'OTHER';
  message: string;
};

/**
 * Response to a `PtyHostRequest`, discriminated on `ok`.
 *
 * Success shape depends on the method:
 * - `spawn` resolves to `{ ptyId: string; pid: number }`.
 * - `write` / `resize` / `kill` / `ack` resolve to `void`.
 *
 * Failure always carries a `PtyHostSpawnError`.
 */
export type PtyHostResponse =
  | { id: number; ok: true; result: { ptyId: string; pid: number } | void }
  | { id: number; ok: false; error: PtyHostSpawnError };

/**
 * Unsolicited events emitted by the ptyHost (no `id` correlation).
 *
 * `exit.signal` is intentionally typed as `number | null` rather than a
 * `NodeJS.Signals` name; preserving the raw numeric form is required for
 * SIGSEGV/SIGABRT/SIGBUS detection at `AbstractCliManager.ts:781-795`.
 */
export type PtyHostEvent =
  | { type: 'data'; ptyId: string; data: string }
  | { type: 'exit'; ptyId: string; exitCode: number | null; signal: number | null }
  | { type: 'heartbeat-pong' };
