import { createReadStream } from 'fs';
import type { UsageEvent, UsageProvider, UsageRateLimitSample } from '../../../../shared/types/usage';
import {
  collectedRateLimits,
  createParseContext,
  parseUsageLine,
  snapshotParseContext,
  type CodexContextSnapshot,
  type ParseContextSnapshot,
} from './usageParser';

export interface ScannedFile {
  events: Array<{ event: UsageEvent; byteOffset: number }>;
  nextOffsetBytes: number;
  linesRead: number;
  rateLimits: UsageRateLimitSample[];
  context: ParseContextSnapshot | null;
}

export async function scanJsonlFile(
  path: string,
  provider: UsageProvider,
  startOffset: number,
  fallbackTimestampMs: number,
  seedContext?: ParseContextSnapshot | CodexContextSnapshot | null
): Promise<ScannedFile> {
  const events: Array<{ event: UsageEvent; byteOffset: number }> = [];
  let offset = startOffset;
  let linesRead = 0;

  const stream = createReadStream(path, { start: startOffset });
  const context = createParseContext(provider, seedContext ?? null);

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

      const event = parseUsageLine(provider, line, fallbackTimestampMs, context);
      if (event) events.push({ event, byteOffset: lineStart });
      linesRead += 1;
      newlineIndex = pending.indexOf(0x0a);
    }
  }

  return {
    events,
    nextOffsetBytes: offset,
    linesRead,
    rateLimits: collectedRateLimits(context),
    context: snapshotParseContext(context),
  };
}

export function resolveStartOffset(
  recorded: { sizeBytes: number; offsetBytes: number } | null,
  currentSize: number
): number {
  if (!recorded) return 0;
  if (currentSize < recorded.sizeBytes) return 0;
  return Math.min(recorded.offsetBytes, currentSize);
}

export function isFileUnchanged(
  recorded: { sizeBytes: number; mtimeMs: number } | null,
  stats: { size: number; mtimeMs: number }
): boolean {
  if (!recorded) return false;
  return recorded.sizeBytes === stats.size && recorded.mtimeMs === stats.mtimeMs;
}
