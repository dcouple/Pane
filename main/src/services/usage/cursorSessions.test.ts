import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CursorSessionRegistry, cursorSessionIdFromPath } from './cursorSessions';

const SESSION_ID = '78c0d50d-8589-46d8-b787-c38fc6f5c6a4';

describe('cursorSessionIdFromPath', () => {
  it('returns the basename UUID and rejects non-UUID names', () => {
    expect(cursorSessionIdFromPath(`/x/agent-transcripts/${SESSION_ID}/${SESSION_ID}.jsonl`)).toBe(SESSION_ID);
    expect(cursorSessionIdFromPath('/x/notes.jsonl')).toBeNull();
  });
});

describe('CursorSessionRegistry', () => {
  let chatsRoot: string;

  beforeEach(async () => {
    chatsRoot = await mkdtemp(join(tmpdir(), 'pane-cursor-chats-'));
  });

  afterEach(async () => {
    await rm(chatsRoot, { recursive: true, force: true });
  });

  it('resolves cwd from a chats/<hash>/<uuid>/meta.json sidecar', async () => {
    const dir = join(chatsRoot, 'abcdef0123456789abcdef0123456789', SESSION_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'meta.json'),
      JSON.stringify({
        schemaVersion: 1,
        cwd: '/repo/alpha',
        createdAtMs: 1,
        updatedAtMs: 2,
      }),
      'utf8'
    );

    const registry = new CursorSessionRegistry(chatsRoot);
    await expect(registry.resolve(SESSION_ID)).resolves.toEqual({
      sessionId: SESSION_ID,
      cwd: '/repo/alpha',
      createdAtMs: 1,
      updatedAtMs: 2,
    });
  });

  it('returns null when no sidecar exists and does not invent a slug cwd', async () => {
    const registry = new CursorSessionRegistry(chatsRoot);
    await expect(registry.resolve(SESSION_ID)).resolves.toBeNull();
  });

  it('caches hits and still finds a late sidecar on a miss', async () => {
    const registry = new CursorSessionRegistry(chatsRoot);
    await expect(registry.resolve(SESSION_ID)).resolves.toBeNull();

    const dir = join(chatsRoot, 'deadbeefdeadbeefdeadbeefdeadbeef', SESSION_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ cwd: '/repo/late' }), 'utf8');

    await expect(registry.resolve(SESSION_ID)).resolves.toMatchObject({
      sessionId: SESSION_ID,
      cwd: '/repo/late',
    });
  });
});
