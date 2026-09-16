import type Database from 'better-sqlite3-multiple-ciphers';
import type { TerminalPanelState, ToolPanelState } from '../../../shared/types/panels';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { trimAnsiSafe } from '../utils/ansiTrim';

/**
 * Terminal bytes never live inside `tool_panels.state`. They go to the
 * `panel_buffers` table, one row per panel, bounded by PANEL_BUFFER_CAP_BYTES
 * across the three columns. `state` stays small metadata JSON.
 */
export const PANEL_BUFFER_CAP_BYTES = 4 * 1024 * 1024;

/** State keys that are split out of `customState`, in `panel_buffers` column order. */
export const PANEL_BUFFER_KEYS = ['scrollbackBuffer', 'serializedBuffer', 'alternateScreenBuffer'] as const;
const BUFFER_COLUMNS = ['scrollback', 'serialized', 'alternate'] as const;

export interface PanelBuffers {
  scrollback: string | null;
  serialized: string | null;
  alternate: string | null;
}

/** `undefined` leaves a column untouched; `null` clears it. */
export interface PanelBufferPatch {
  scrollback?: string | null;
  serialized?: string | null;
  alternate?: string | null;
}

interface PanelStateSplit {
  /** The state with the three buffer keys removed. */
  state: ToolPanelState;
  /** Buffer columns the caller wrote, or null when the state carried none. */
  patch: PanelBufferPatch | null;
}

interface PanelBufferCapResult {
  buffers: PanelBuffers;
  trimmedBytes: number;
}

interface PanelBufferRow {
  scrollback: Buffer | null;
  serialized: Buffer | null;
  alternate: Buffer | null;
}

interface PanelBufferLengthRow {
  scrollback: number;
  serialized: number;
  alternate: number;
}

const EMPTY_BUFFERS: PanelBuffers = { scrollback: null, serialized: null, alternate: null };
const ZERO_LENGTHS: PanelBufferLengthRow = { scrollback: 0, serialized: 0, alternate: 0 };

const scrollbackSchema = boundary.union(boundary.string, boundary.array(boundary.string));

function normalizeScrollback(value: TerminalPanelState['scrollbackBuffer']): string | null {
  const decoded = decodeOptionalBoundary(value, scrollbackSchema);
  if (decoded === undefined) return null;
  return Array.isArray(decoded) ? decoded.join('\n') : decoded;
}

function normalizeText(value: string | undefined): string | null {
  return decodeOptionalBoundary(value, boundary.string) ?? null;
}

function byteLength(text: string | null): number {
  return text === null ? 0 : Buffer.byteLength(text, 'utf8');
}

function totalBytes(buffers: PanelBuffers): number {
  return byteLength(buffers.scrollback) + byteLength(buffers.serialized) + byteLength(buffers.alternate);
}

function toText(value: Buffer | null): string | null {
  return value === null ? null : value.toString('utf8');
}

function toBlob(value: string | null): Buffer | null {
  return value === null ? null : Buffer.from(value, 'utf8');
}

/**
 * Pull the terminal byte buffers out of a panel state so `tool_panels.state`
 * never carries them. A key that is present, even as `undefined`, becomes a
 * patch entry (undefined clears, mirroring the JSON merge it replaces); an
 * absent key leaves the stored buffer untouched.
 */
export function splitPanelBufferState(state: ToolPanelState): PanelStateSplit {
  const customState = state.customState;
  if (!customState) return { state, patch: null };

  const hasScrollback = Object.hasOwn(customState, 'scrollbackBuffer');
  const hasSerialized = Object.hasOwn(customState, 'serializedBuffer');
  const hasAlternate = Object.hasOwn(customState, 'alternateScreenBuffer');
  if (!hasScrollback && !hasSerialized && !hasAlternate) return { state, patch: null };

  // SAFETY: Only terminal panels persist these three keys; the destructuring
  // reads nothing else and every value is decoded before it is stored.
  const { scrollbackBuffer, serializedBuffer, alternateScreenBuffer, ...rest } = customState as TerminalPanelState;
  const patch: PanelBufferPatch = {};
  if (hasScrollback) patch.scrollback = normalizeScrollback(scrollbackBuffer);
  if (hasSerialized) patch.serialized = normalizeText(serializedBuffer);
  if (hasAlternate) patch.alternate = normalizeText(alternateScreenBuffer);
  return { state: { ...state, customState: rest }, patch };
}

/** Trim a UTF-8 string to at most `targetBytes`, dropping the oldest bytes. */
function trimToBytes(text: string, targetBytes: number): string {
  let result = text;
  for (let attempt = 0; attempt < 8 && byteLength(result) > targetBytes; attempt += 1) {
    const ratio = targetBytes / byteLength(result);
    result = trimAnsiSafe(result, Math.floor(result.length * ratio));
    if (result.length === 0) break;
  }
  return byteLength(result) > targetBytes ? '' : result;
}

/**
 * Enforce the per-panel cap across the three buffers. The oldest scrollback
 * goes first, then the serialized snapshot, then the alternate-screen frame,
 * each trimmed from its start so the newest bytes survive.
 */
function applyPanelBufferCap(buffers: PanelBuffers, capBytes: number): PanelBufferCapResult {
  const total = totalBytes(buffers);
  let over = total - capBytes;
  if (over <= 0) return { buffers, trimmedBytes: 0 };

  const capped: PanelBuffers = { ...buffers };
  for (const column of BUFFER_COLUMNS) {
    if (over <= 0) break;
    const text = capped[column];
    if (text === null || text.length === 0) continue;
    const bytes = byteLength(text);
    if (bytes <= over) {
      capped[column] = null;
      over -= bytes;
      continue;
    }
    capped[column] = trimToBytes(text, bytes - over);
    over = 0;
  }
  return { buffers: capped, trimmedBytes: total - totalBytes(capped) };
}

export class PanelBufferStore {
  /** Panels that already logged a trim warning this process. */
  private readonly warnedPanels = new Set<string>();

  constructor(private readonly db: Database.Database) {}

  get(panelId: string): PanelBuffers | null {
    // SAFETY: This fixed SQLite query projection matches the declared row type at this database boundary.
    const row = this.db
      .prepare('SELECT scrollback, serialized, alternate FROM panel_buffers WHERE panel_id = ?')
      .get(panelId) as PanelBufferRow | undefined;
    if (!row) return null;
    return {
      scrollback: toText(row.scrollback),
      serialized: toText(row.serialized),
      alternate: toText(row.alternate),
    };
  }

  /** Byte size of each stored column, zero when the row or column is absent. */
  private getLengths(panelId: string): PanelBufferLengthRow {
    // SAFETY: This fixed SQLite query projection matches the declared row type at this database boundary.
    const row = this.db
      .prepare(
        `SELECT COALESCE(LENGTH(scrollback), 0) AS scrollback,
                COALESCE(LENGTH(serialized), 0) AS serialized,
                COALESCE(LENGTH(alternate), 0) AS alternate
         FROM panel_buffers WHERE panel_id = ?`,
      )
      .get(panelId) as PanelBufferLengthRow | undefined;
    return row ?? ZERO_LENGTHS;
  }

  /**
   * Merge a patch into the panel's row, enforcing the cap on the merged
   * result. Trimming logs one warning per panel per process, never silently.
   * A panel that no longer exists is left alone (its row cascades with it).
   */
  apply(panelId: string, patch: PanelBufferPatch): void {
    const columns = BUFFER_COLUMNS.filter((column) => patch[column] !== undefined);
    if (columns.length === 0) return;

    // The stored row is only consulted for columns the patch leaves alone;
    // the usual full save touches all three and never reads it.
    const coversAll = columns.length === BUFFER_COLUMNS.length;
    const stored = coversAll ? ZERO_LENGTHS : this.getLengths(panelId);
    let bytes = BUFFER_COLUMNS.reduce((sum, column) => {
      const value = patch[column];
      return sum + (value === undefined ? stored[column] : byteLength(value));
    }, 0);

    let writes: PanelBufferPatch = patch;
    if (bytes > PANEL_BUFFER_CAP_BYTES) {
      const existing = coversAll ? null : this.get(panelId);
      const merged: PanelBuffers = { ...EMPTY_BUFFERS, ...existing, ...patch };
      const capped = applyPanelBufferCap(merged, PANEL_BUFFER_CAP_BYTES);
      writes = capped.buffers;
      bytes = totalBytes(capped.buffers);
      if (capped.trimmedBytes > 0 && !this.warnedPanels.has(panelId)) {
        this.warnedPanels.add(panelId);
        console.warn(
          `[PanelBuffers] Trimmed ${capped.trimmedBytes} bytes from panel ${panelId} ` +
          `to stay under the ${PANEL_BUFFER_CAP_BYTES} byte cap (oldest scrollback first)`,
        );
      }
    }

    const written = BUFFER_COLUMNS.filter((column) => writes[column] !== undefined);
    this.db
      .prepare(
        `INSERT INTO panel_buffers (panel_id, ${written.join(', ')}, bytes)
         SELECT ?, ${written.map(() => '?').join(', ')}, ?
         WHERE EXISTS (SELECT 1 FROM tool_panels WHERE id = ?)
         ON CONFLICT(panel_id) DO UPDATE SET
           ${written.map((column) => `${column} = excluded.${column}`).join(', ')},
           bytes = excluded.bytes,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(panelId, ...written.map((column) => toBlob(writes[column] ?? null)), bytes, panelId);
    if (bytes === 0) {
      this.db
        .prepare('DELETE FROM panel_buffers WHERE panel_id = ? AND scrollback IS NULL AND serialized IS NULL AND alternate IS NULL')
        .run(panelId);
    }
  }
}
