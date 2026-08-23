import { createReadStream } from 'fs';
import type { UsageEvent, UsageProvider, UsageRateLimitSample } from '../../../../shared/types/usage';
import {
  createCodexContext,
  parseUsageLine,
  snapshotCodexContext,
  type CodexContextSnapshot,
} from './usageParser';

export interface ScannedFile {
  /** Events parsed from the bytes read in this pass. */
  events: Array<{ event: UsageEvent; byteOffset: number }>;
  /** Byte offset to resume from next time — end of the last *complete* line. */
  nextOffsetBytes: number;
  linesRead: number;
  /** Provider-reported quota state observed in this pass, newest per limit. */
  rateLimits: UsageRateLimitSample[];
  /**
   * Codex attribution as it stood at `nextOffsetBytes`, to be handed back to
   * the next pass. Null for Claude, whose lines each carry their own.
   */
  context: CodexContextSnapshot | null;
}

/**
 * Read a JSONL transcript from `startOffset` and parse its usage events.
 *
 * Two details make this safe to re-run continuously:
 *
 * 1. **Byte-accurate offsets.** Offsets advance by `Buffer.byteLength(line)`,
 *    not `line.length` — transcripts contain non-ASCII, and a character count
 *    would desynchronise the cursor from the file.
 * 2. **Complete lines only.** An agent may be mid-write when we read, so the
 *    cursor only advances past lines that ended with a newline. A partial
 *    trailing line is re-read on the next pass instead of being lost or
 *    double-counted.
 * 3. **Carried attribution.** Codex names the model, session and cwd once, at
 *    the top of the transcript. A pass that starts at an offset is past them,
 *    so `seedContext` — what the previous pass ended with — stands in for the
 *    lines it cannot see.
 */
export async function scanJsonlFile(
  path: string,
  provider: UsageProvider,
  startOffset: number,
  fallbackTimestampMs: number,
  seedContext?: CodexContextSnapshot | null
): Promise<ScannedFile> {
  const events: Array<{ event: UsageEvent; byteOffset: number }> = [];
  let offset = startOffset;
  let linesRead = 0;

  const stream = createReadStream(path, { start: startOffset });

  // Codex attributes usage from earlier lines in the same file (model, session,
  // cwd), so the parser carries state across the whole transcript — including
  // across the pass boundary, via the seed.
  const codexContext = provider === 'codex' ? createCodexContext(seedContext) : undefined;
  const collectedRateLimits = (): UsageRateLimitSample[] =>
    codexContext ? [...codexContext.rateLimits.values()] : [];
  const carriedContext = (): CodexContextSnapshot | null =>
    codexContext ? snapshotCodexContext(codexContext) : null;

  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length === 0 ? buffer : Buffer.concat([pending, buffer]);

    let newlineIndex = pending.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const lineStart = offset;
      const lineEnd = newlineIndex > 0 && pending[newlineIndex - 1] === 0x0d
        ? newlineIndex - 1
        : newlineIndex;
      const line = pending.subarray(0, lineEnd).toString('utf8');
      offset += newlineIndex + 1;
      pending = pending.subarray(newlineIndex + 1);

      const event = parseUsageLine(provider, line, fallbackTimestampMs, codexContext);
      if (event) events.push({ event, byteOffset: lineStart });
      linesRead += 1;
      newlineIndex = pending.indexOf(0x0a);
    }
  }

  return {
    events,
    nextOffsetBytes: offset,
    linesRead,
    rateLimits: collectedRateLimits(),
    context: carriedContext(),
  };
}

/**
 * Decide where to resume reading a file.
 *
 * A file smaller than the recorded size was truncated or rotated, so its
 * cursor is meaningless and the whole file is re-read.
 */
export function resolveStartOffset(
  recorded: { sizeBytes: number; offsetBytes: number } | null,
  currentSize: number
): number {
  if (!recorded) return 0;
  if (currentSize < recorded.sizeBytes) return 0;
  return Math.min(recorded.offsetBytes, currentSize);
}

/** True when the file is byte-for-byte what we last indexed. */
export function isFileUnchanged(
  recorded: { sizeBytes: number; mtimeMs: number } | null,
  stats: { size: number; mtimeMs: number }
): boolean {
  if (!recorded) return false;
  return recorded.sizeBytes === stats.size && recorded.mtimeMs === stats.mtimeMs;
}
