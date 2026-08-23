import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanJsonlFile, resolveStartOffset, isFileUnchanged } from './jsonlScanner';

const FALLBACK_MS = 1_700_000_000_000;

function assistantLine(id: string, inputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-01T10:00:00.000Z',
    message: { id, model: 'claude-sonnet-5', usage: { input_tokens: inputTokens, output_tokens: 1 } },
  });
}

describe('resolveStartOffset', () => {
  it('starts at zero for an unseen file', () => {
    expect(resolveStartOffset(null, 100)).toBe(0);
  });

  it('resumes from the stored offset', () => {
    expect(resolveStartOffset({ sizeBytes: 100, offsetBytes: 80 }, 120)).toBe(80);
  });

  it('re-reads from the start when the file shrank (rotation or truncation)', () => {
    expect(resolveStartOffset({ sizeBytes: 100, offsetBytes: 80 }, 40)).toBe(0);
  });

  it('never resumes past the current end of file', () => {
    expect(resolveStartOffset({ sizeBytes: 100, offsetBytes: 999 }, 100)).toBe(100);
  });
});

describe('isFileUnchanged', () => {
  it('is false without a recorded cursor', () => {
    expect(isFileUnchanged(null, { size: 10, mtimeMs: 1 })).toBe(false);
  });

  it('requires both size and mtime to match', () => {
    expect(isFileUnchanged({ sizeBytes: 10, mtimeMs: 1 }, { size: 10, mtimeMs: 1 })).toBe(true);
    expect(isFileUnchanged({ sizeBytes: 10, mtimeMs: 1 }, { size: 11, mtimeMs: 1 })).toBe(false);
    expect(isFileUnchanged({ sizeBytes: 10, mtimeMs: 1 }, { size: 10, mtimeMs: 2 })).toBe(false);
  });
});

describe('scanJsonlFile', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pane-usage-'));
    file = join(dir, 'transcript.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses every complete line of a fresh file', async () => {
    await writeFile(file, `${assistantLine('a', 10)}\n${assistantLine('b', 20)}\n`, 'utf8');

    const result = await scanJsonlFile(file, 'claude', 0, FALLBACK_MS);

    expect(result.linesRead).toBe(2);
    expect(result.events.map(e => e.event.inputTokens)).toEqual([10, 20]);
  });

  it('reads only the appended delta on a second pass', async () => {
    await writeFile(file, `${assistantLine('a', 10)}\n`, 'utf8');
    const first = await scanJsonlFile(file, 'claude', 0, FALLBACK_MS);

    await appendFile(file, `${assistantLine('b', 20)}\n`, 'utf8');
    const second = await scanJsonlFile(file, 'claude', first.nextOffsetBytes, FALLBACK_MS);

    expect(second.events).toHaveLength(1);
    expect(second.events[0].event.inputTokens).toBe(20);
  });

  it('keeps byte offsets aligned across multi-byte characters', async () => {
    // A cwd with non-ASCII makes a character-count offset drift from the file.
    const withUnicode = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-01T10:00:00.000Z',
      cwd: '/répertoire/工作/проект',
      message: { id: 'u1', model: 'claude-sonnet-5', usage: { input_tokens: 7, output_tokens: 1 } },
    });
    await writeFile(file, `${withUnicode}\n`, 'utf8');

    const first = await scanJsonlFile(file, 'claude', 0, FALLBACK_MS);
    expect(first.nextOffsetBytes).toBe(Buffer.byteLength(`${withUnicode}\n`, 'utf8'));

    await appendFile(file, `${assistantLine('b', 20)}\n`, 'utf8');
    const second = await scanJsonlFile(file, 'claude', first.nextOffsetBytes, FALLBACK_MS);

    expect(second.events).toHaveLength(1);
    expect(second.events[0].event.messageId).toBe('b');
  });

  it('keeps byte offsets aligned across CRLF line endings', async () => {
    const firstLine = assistantLine('a', 10);
    await writeFile(file, `${firstLine}\r\n`, 'utf8');

    const first = await scanJsonlFile(file, 'claude', 0, FALLBACK_MS);
    expect(first.nextOffsetBytes).toBe(Buffer.byteLength(`${firstLine}\r\n`, 'utf8'));

    await appendFile(file, `${assistantLine('b', 20)}\r\n`, 'utf8');
    const second = await scanJsonlFile(file, 'claude', first.nextOffsetBytes, FALLBACK_MS);

    expect(second.events).toHaveLength(1);
    expect(second.events[0].event.messageId).toBe('b');
  });

  it('holds back a partially written trailing line until it completes', async () => {
    const partial = assistantLine('b', 20).slice(0, 30);
    await writeFile(file, `${assistantLine('a', 10)}\n${partial}`, 'utf8');

    const first = await scanJsonlFile(file, 'claude', 0, FALLBACK_MS);

    // Only the complete line is reported, and the cursor stops before the partial one.
    expect(first.events).toHaveLength(1);
    expect(first.events[0].event.messageId).toBe('a');
    expect(first.nextOffsetBytes).toBe(Buffer.byteLength(`${assistantLine('a', 10)}\n`, 'utf8'));

    // Finish the line; the second pass picks it up exactly once.
    await writeFile(file, `${assistantLine('a', 10)}\n${assistantLine('b', 20)}\n`, 'utf8');
    const second = await scanJsonlFile(file, 'claude', first.nextOffsetBytes, FALLBACK_MS);

    expect(second.events).toHaveLength(1);
    expect(second.events[0].event.messageId).toBe('b');
  });

  it('returns nothing for an empty file', async () => {
    await writeFile(file, '', 'utf8');
    const result = await scanJsonlFile(file, 'claude', 0, FALLBACK_MS);
    expect(result).toEqual({
      events: [], nextOffsetBytes: 0, linesRead: 0, rateLimits: [], context: null,
    });
  });

  it('surfaces Codex quota samples alongside the events', async () => {
    const line = JSON.stringify({
      timestamp: '2026-05-01T11:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } },
        rate_limits: { limit_id: 'codex', primary: { used_percent: 42, window_minutes: 300 } },
      },
    });
    await writeFile(file, `${line}\n`, 'utf8');

    const result = await scanJsonlFile(file, 'codex', 0, FALLBACK_MS);

    expect(result.events).toHaveLength(1);
    expect(result.rateLimits).toHaveLength(1);
    expect(result.rateLimits[0].usedPercent).toBe(42);
  });

  it('reports no quota samples for Claude, which does not publish any', async () => {
    await writeFile(file, `${assistantLine('a', 10)}\n`, 'utf8');
    const result = await scanJsonlFile(file, 'claude', 0, FALLBACK_MS);
    expect(result.rateLimits).toEqual([]);
  });

  it('skips malformed lines without losing the rest of the file', async () => {
    await writeFile(
      file,
      `${assistantLine('a', 10)}\nnot json\n{"type":"assistant"\n${assistantLine('b', 20)}\n`,
      'utf8'
    );

    const result = await scanJsonlFile(file, 'claude', 0, FALLBACK_MS);

    expect(result.linesRead).toBe(4);
    expect(result.events.map(e => e.event.messageId)).toEqual(['a', 'b']);
  });

  it('reports byte offsets that point at the start of each line', async () => {
    const lineA = assistantLine('a', 10);
    await writeFile(file, `${lineA}\n${assistantLine('b', 20)}\n`, 'utf8');

    const result = await scanJsonlFile(file, 'claude', 0, FALLBACK_MS);

    expect(result.events[0].byteOffset).toBe(0);
    expect(result.events[1].byteOffset).toBe(Buffer.byteLength(`${lineA}\n`, 'utf8'));
  });
});
