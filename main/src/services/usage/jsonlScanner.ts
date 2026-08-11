import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { createInterface } from 'readline';
import type { UsageEvent, UsageProvider, UsageRateLimitSample } from '../../../../shared/types/usage';
import { createCodexContext, parseUsageLine } from './usageParser';

export interface ScannedFile {
  /** Events parsed from the bytes read in this pass. */
  events: Array<{ event: UsageEvent; byteOffset: number }>;
  /** Byte offset to resume from next time — end of the last *complete* line. */
  nextOffsetBytes: number;
  linesRead: number;
  /** Provider-reported quota state observed in this pass, newest per limit. */
  rateLimits: UsageRateLimitSample[];
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
 */
export async function scanJsonlFile(
  path: string,
  provider: UsageProvider,
  startOffset: number,
  fallbackTimestampMs: number
): Promise<ScannedFile> {
  // Determine up front whether the file currently ends mid-line; the answer
  // decides whether the final emitted line may be trusted.
  const endsWithNewline = await fileEndsWithNewline(path);

  const events: Array<{ event: UsageEvent; byteOffset: number }> = [];
  let offset = startOffset;
  let lastLineStart = startOffset;
  let linesRead = 0;

  const stream = createReadStream(path, { start: startOffset, encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  // Codex attributes usage from earlier lines in the same file (model, session,
  // cwd), so the parser carries state across the whole transcript.
  const codexContext = provider === 'codex' ? createCodexContext() : undefined;
  const collectedRateLimits = (): UsageRateLimitSample[] =>
    codexContext ? [...codexContext.rateLimits.values()] : [];

  try {
    for await (const line of reader) {
      lastLineStart = offset;
      // readline strips the terminator, so add it back to keep the cursor
      // aligned with the file's actual bytes.
      offset += Buffer.byteLength(line, 'utf8') + 1;

      const event = parseUsageLine(provider, line, fallbackTimestampMs, codexContext);
      if (event) events.push({ event, byteOffset: lastLineStart });
      linesRead += 1;
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  if (endsWithNewline || linesRead === 0) {
    return { events, nextOffsetBytes: offset, linesRead, rateLimits: collectedRateLimits() };
  }

  // The last line was still being written. Rewind to its start and discard
  // anything parsed from it, so the completed line is picked up next pass.
  while (events.length > 0 && events[events.length - 1].byteOffset >= lastLineStart) {
    events.pop();
  }
  return {
    events,
    nextOffsetBytes: Math.max(startOffset, lastLineStart),
    linesRead: linesRead - 1,
    rateLimits: collectedRateLimits(),
  };
}

/**
 * Whether the file's final byte is a newline. Only the last byte is read, so
 * this stays cheap even for very large transcripts.
 */
async function fileEndsWithNewline(path: string): Promise<boolean> {
  const stats = await stat(path);
  if (stats.size === 0) return true;

  return new Promise<boolean>((resolve) => {
    const stream = createReadStream(path, { start: stats.size - 1, end: stats.size - 1 });
    let byte: number | null = null;
    stream.on('data', (chunk: string | Buffer) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (buffer.length > 0) byte = buffer[buffer.length - 1];
    });
    stream.on('error', () => resolve(true));
    stream.on('close', () => resolve(byte === 0x0a));
  });
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
