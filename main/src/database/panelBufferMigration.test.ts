import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database';
import { PANEL_BUFFER_SCHEMA_VERSION } from './panelBufferMigration';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const bytesSchema = boundary.object({ bytes: boundary.number });

function backupFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.includes('.pre-panel-buffers-'));
}

describe('panel buffer migration', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-panel-migration-'));
    dbPath = path.join(tempDir, 'sessions.db');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('versions a fresh database without a backup or a rewrite', () => {
    const db = new DatabaseService(dbPath);
    db.initialize();
    try {
      expect(db.getPanelBufferMigration()).toEqual({ result: expect.objectContaining({ migrated: false }), error: null });
      expect(db.getDb().pragma('user_version', { simple: true })).toBe(PANEL_BUFFER_SCHEMA_VERSION);
      expect(backupFiles(tempDir)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('moves a 30 MB legacy row into panel_buffers, leaves state under 10 KB, backs up first, and runs once', () => {
    const seed = new DatabaseService(dbPath);
    seed.initialize();
    seed.createSession({
      id: 'session', name: 'session', initial_prompt: '', worktree_name: 'session',
      worktree_path: tempDir, project_id: null, tool_type: 'none',
    });
    const sqlite = seed.getDb();
    const insert = sqlite.prepare('INSERT INTO tool_panels (id, session_id, type, title, state) VALUES (?, ?, ?, ?, ?)');

    // What the pty output heuristic accumulated: cursor moves, colors and
    // braille spinner glyphs, never a newline.
    const frame = '\x1b[1;1H\x1b[2K\x1b[38;5;208m⠋ working\x1b[0m';
    const lastActiveCommand = frame.repeat(Math.ceil((30 * 1024 * 1024) / Buffer.byteLength(frame, 'utf8')));
    expect(Buffer.byteLength(lastActiveCommand, 'utf8')).toBeGreaterThanOrEqual(30 * 1024 * 1024);
    insert.run('legacy', 'session', 'terminal', 'Codex', JSON.stringify({
      isActive: false,
      hasBeenViewed: true,
      customState: {
        cwd: '/repo',
        isCliPanel: true,
        isAlternateScreen: true,
        scrollbackBuffer: 'shell history\r\n',
        serializedBuffer: 'serialized snapshot',
        alternateScreenBuffer: 'alternate frame',
        lastActiveCommand,
        commandHistory: ['ls', lastActiveCommand.slice(0, 100_000)],
      },
    }));
    // The string-wrapped legacy format with the array scrollback shape.
    insert.run('wrapped', 'session', 'terminal', 'Legacy', JSON.stringify(JSON.stringify({
      isActive: false,
      customState: { cwd: '/wrapped', scrollbackBuffer: ['first', 'second'] },
    })));
    insert.run('logs', 'session', 'logs', 'Logs', JSON.stringify({ isActive: false, customState: { isRunning: false } }));
    insert.run('empty', 'session', 'terminal', 'Empty', null);
    sqlite.pragma('user_version = 0');
    seed.close();
    const sizeBefore = fs.statSync(dbPath).size;
    expect(sizeBefore).toBeGreaterThan(30 * 1024 * 1024);

    const db = new DatabaseService(dbPath);
    db.initialize();
    try {
      const { result, error } = db.getPanelBufferMigration();
      expect(error).toBeNull();
      expect(result).toMatchObject({ migrated: true, panelsRepaired: 2, panelsWithBuffers: 2 });
      expect(result?.fileBytesBefore ?? 0).toBeGreaterThanOrEqual(sizeBefore);
      expect(result?.backupPath).toBe(path.join(tempDir, backupFiles(tempDir)[0]));
      expect(backupFiles(tempDir)).toHaveLength(1);
      expect(fs.statSync(result?.backupPath ?? '').size).toBe(result?.fileBytesBefore);
      expect(result?.fileBytesAfter ?? Infinity).toBeLessThan(1024 * 1024);

      const stateBytes = decodeBoundary(
        db.getDb().prepare('SELECT LENGTH(CAST(state AS BLOB)) AS bytes FROM tool_panels WHERE id = ?').get('legacy'),
        bytesSchema,
      ).bytes;
      expect(stateBytes).toBeLessThan(10 * 1024);
      expect(db.getPanel('legacy')?.state.customState).toEqual({ cwd: '/repo', isCliPanel: true, isAlternateScreen: true });
      expect(db.getPanelBuffers('legacy')).toEqual({
        scrollback: 'shell history\r\n',
        serialized: 'serialized snapshot',
        alternate: 'alternate frame',
      });
      expect(db.getPanel('wrapped')?.state.customState).toEqual({ cwd: '/wrapped' });
      expect(db.getPanelBuffers('wrapped')).toEqual({ scrollback: 'first\nsecond', serialized: null, alternate: null });
      expect(db.getPanel('logs')?.state.customState).toEqual({ isRunning: false });
      expect(db.getPanel('empty')?.state.customState).toEqual({});
      expect(db.getDb().pragma('user_version', { simple: true })).toBe(PANEL_BUFFER_SCHEMA_VERSION);

      // The repaired row is writable again through the normal partial merge.
      expect(db.updatePanel('legacy', { state: { isActive: false, customState: { isCliReady: true } } })).toBe(true);
      expect(db.getPanel('legacy')?.state.customState).toEqual({
        cwd: '/repo', isCliPanel: true, isAlternateScreen: true, isCliReady: true,
      });
    } finally {
      db.close();
    }

    const reopened = new DatabaseService(dbPath);
    reopened.initialize();
    try {
      expect(reopened.getPanelBufferMigration().result).toMatchObject({ migrated: false });
      expect(backupFiles(tempDir)).toHaveLength(1);
      expect(reopened.getPanelBuffers('legacy')?.serialized).toBe('serialized snapshot');
    } finally {
      reopened.close();
    }
  });
});
