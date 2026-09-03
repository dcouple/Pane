import { basename } from 'path';
import { glob } from 'glob';
import { readFile } from 'fs/promises';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const metaSchema = boundary.object({
  cwd: boundary.optional(boundary.string),
  createdAtMs: boundary.optional(boundary.number),
  updatedAtMs: boundary.optional(boundary.number),
});

export interface CursorSessionMeta {
  sessionId: string;
  cwd: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
}

/** Basename sans `.jsonl`; null if not a UUID. */
export function cursorSessionIdFromPath(path: string): string | null {
  const id = basename(path, '.jsonl');
  return UUID_PATTERN.test(id) ? id : null;
}

/**
 * Resolves a Cursor session cwd from chats/<hash>/<uuid>/meta.json.
 * The md5 project prefix is not invertible, so lookup is a glob. Read-only.
 */
export class CursorSessionRegistry {
  private readonly hits = new Map<string, CursorSessionMeta>();

  constructor(private readonly chatsRoot: string) {}

  async resolve(sessionId: string): Promise<CursorSessionMeta | null> {
    const cached = this.hits.get(sessionId);
    if (cached) return cached;

    const meta = await this.readMeta(sessionId);
    if (meta) this.hits.set(sessionId, meta);
    return meta;
  }

  async preload(): Promise<void> {
    const matches = await glob('*/**/meta.json', {
      cwd: this.chatsRoot,
      absolute: true,
      nodir: true,
    });
    for (const path of matches) {
      const sessionId = basename(path.replace(/[/\\]meta\.json$/i, ''));
      if (!UUID_PATTERN.test(sessionId)) continue;
      if (this.hits.has(sessionId)) continue;
      const meta = await this.readMetaAt(path, sessionId);
      if (meta) this.hits.set(sessionId, meta);
    }
  }

  private async readMeta(sessionId: string): Promise<CursorSessionMeta | null> {
    const matches = await glob(`*/${sessionId}/meta.json`, {
      cwd: this.chatsRoot,
      absolute: true,
      nodir: true,
    });
    if (matches.length === 0 || matches[0] === undefined) return null;
    return this.readMetaAt(matches[0], sessionId);
  }

  private async readMetaAt(path: string, sessionId: string): Promise<CursorSessionMeta | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      const meta = decodeOptionalBoundary(parsed, metaSchema);
      if (!meta) return null;
      const cwd = meta.cwd && meta.cwd.length > 0 ? meta.cwd : null;
      return {
        sessionId,
        cwd,
        createdAtMs: meta.createdAtMs ?? null,
        updatedAtMs: meta.updatedAtMs ?? null,
      };
    } catch {
      return null;
    }
  }
}
