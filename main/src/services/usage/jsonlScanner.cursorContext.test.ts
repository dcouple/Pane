import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanJsonlFile } from './jsonlScanner';

const FALLBACK_MS = 1_700_000_000_000;
const SESSION_ID = '78c0d50d-8589-46d8-b787-c38fc6f5c6a4';

function assistantLine(text: string): string {
  return JSON.stringify({
    role: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
}

describe('scanJsonlFile carries Cursor attribution across passes', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pane-usage-cursor-'));
    file = join(dir, `${SESSION_ID}.jsonl`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('seeds session id and cwd onto every assistant line and ignores token-shaped keys', async () => {
    const seed = { provider: 'cursor' as const, sessionId: SESSION_ID, cwd: '/repo/alpha' };
    await writeFile(
      file,
      `${assistantLine('one')}\n${JSON.stringify({ type: 'turn_ended' })}\n`,
      'utf8'
    );

    const first = await scanJsonlFile(file, 'cursor', 0, FALLBACK_MS, seed);
    expect(first.events).toHaveLength(1);
    expect(first.events[0].event).toEqual({
      provider: 'cursor',
      timestampMs: FALLBACK_MS,
      model: 'cursor',
      tokens: null,
      agentSessionId: SESSION_ID,
      messageId: null,
      cwd: '/repo/alpha',
    });
    expect(first.context).toEqual(seed);

    await appendFile(file, `${assistantLine('two')}\n`, 'utf8');
    const resumed = await scanJsonlFile(file, 'cursor', first.nextOffsetBytes, FALLBACK_MS, first.context);
    expect(resumed.events).toHaveLength(1);
    expect(resumed.events[0].event.cwd).toBe('/repo/alpha');
    expect(resumed.events[0].event.tokens).toBeNull();
    expect(resumed.context).toEqual(seed);
  });

  it('picks up a late cwd on a from-zero re-read', async () => {
    await writeFile(file, `${assistantLine('one')}\n`, 'utf8');
    const missing = await scanJsonlFile(file, 'cursor', 0, FALLBACK_MS, {
      provider: 'cursor',
      sessionId: SESSION_ID,
      cwd: null,
    });
    expect(missing.events[0].event.cwd).toBeNull();

    const filled = await scanJsonlFile(file, 'cursor', 0, FALLBACK_MS, {
      provider: 'cursor',
      sessionId: SESSION_ID,
      cwd: '/repo/late',
    });
    expect(filled.events[0].event.cwd).toBe('/repo/late');
  });
});
