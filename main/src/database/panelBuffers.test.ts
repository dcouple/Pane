import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService, PANEL_STATE_CEILING_BYTES } from './database';
import { PANEL_BUFFER_CAP_BYTES, splitPanelBufferState } from './panelBuffers';
import { ScrollbackRetentionService } from '../services/scrollbackRetention';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const rawStateSchema = boundary.object({ state: boundary.string });
const bytesSchema = boundary.object({ bytes: boundary.number });

describe('panel buffers and the panel state ceiling', () => {
  let tempDir: string;
  let db: DatabaseService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-panel-buffers-'));
    db = new DatabaseService(path.join(tempDir, 'sessions.db'));
    db.initialize();
    db.createSession({
      id: 'session', name: 'session', initial_prompt: '', worktree_name: 'session',
      worktree_path: tempDir, project_id: null, tool_type: 'none',
    });
    vi.mocked(console.error).mockClear();
    vi.mocked(console.warn).mockClear();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function rawState(panelId: string): string {
    return decodeBoundary(
      db.getDb().prepare('SELECT state FROM tool_panels WHERE id = ?').get(panelId),
      rawStateSchema,
    ).state;
  }

  it('keeps terminal bytes out of the state row and merges the rest key by key', () => {
    db.createPanel({
      id: 'panel', sessionId: 'session', type: 'terminal', title: 'Terminal',
      state: {
        isActive: false,
        hasBeenViewed: false,
        customState: {
          cwd: tempDir,
          isAlternateScreen: false,
          scrollbackBuffer: 'one\r\ntwo',
          serializedBuffer: 'snapshot',
          alternateScreenBuffer: 'frame',
        },
      },
    });

    expect(db.getPanel('panel')?.state.customState).toEqual({ cwd: tempDir, isAlternateScreen: false });
    expect(rawState('panel')).not.toContain('scrollbackBuffer');
    expect(db.getPanelBuffers('panel')).toEqual({ scrollback: 'one\r\ntwo', serialized: 'snapshot', alternate: 'frame' });

    // Only the keys present in the update change; undefined removes; legacy arrays join.
    expect(db.updatePanel('panel', {
      state: {
        isActive: false,
        customState: { scrollbackBuffer: ['a', 'b'], serializedBuffer: undefined, dimensions: { cols: 10, rows: 5 } },
      },
    })).toBe(true);
    expect(db.getPanelBuffers('panel')).toEqual({ scrollback: 'a\nb', serialized: null, alternate: 'frame' });
    expect(db.getPanel('panel')?.state.customState).toEqual({
      cwd: tempDir, isAlternateScreen: false, dimensions: { cols: 10, rows: 5 },
    });

    expect(db.updatePanel('panel', { state: { isActive: false, hasBeenViewed: true, customState: { cwd: undefined } } })).toBe(true);
    expect(db.getPanel('panel')?.state).toEqual({
      isActive: false, hasBeenViewed: true, customState: { isAlternateScreen: false, dimensions: { cols: 10, rows: 5 } },
    });

    expect(db.updatePanel('panel', { title: 'Renamed' })).toBe(true);
    expect(db.getPanel('panel')?.title).toBe('Renamed');
    expect(db.getPanel('panel')?.state.customState).toEqual({ isAlternateScreen: false, dimensions: { cols: 10, rows: 5 } });

    // Clearing every buffer drops the row.
    expect(db.updatePanel('panel', {
      state: { isActive: false, customState: { scrollbackBuffer: undefined, alternateScreenBuffer: undefined } },
    })).toBe(true);
    expect(db.getPanelBuffers('panel')).toBeNull();
  });

  it('splits a state into buffer-free state and a patch without touching absent keys', () => {
    const split = splitPanelBufferState({
      isActive: true,
      customState: { cwd: '/repo', scrollbackBuffer: ['x', 'y'], serializedBuffer: undefined },
    });
    expect(split.state).toEqual({ isActive: true, customState: { cwd: '/repo' } });
    expect(split.patch).toEqual({ scrollback: 'x\ny', serialized: null });
    expect(splitPanelBufferState({ isActive: false, customState: { cwd: '/repo' } }).patch).toBeNull();
  });

  it('refuses a state write over 256 KB with a logged error and accepts one at 200 KB', () => {
    db.createPanel({
      id: 'panel', sessionId: 'session', type: 'terminal', title: 'Terminal',
      state: { isActive: false, customState: { cwd: tempDir } },
    });
    const accepted = 'x'.repeat(200 * 1024);

    expect(db.updatePanel('panel', { state: { isActive: false, customState: { initialInput: accepted } } })).toBe(true);
    expect(db.getPanel('panel')?.state.customState).toEqual({ cwd: tempDir, initialInput: accepted });
    expect(console.error).not.toHaveBeenCalled();

    const refused = db.updatePanel('panel', {
      title: 'Should not change',
      state: { isActive: false, customState: { initialInput: 'y'.repeat(300 * 1024), scrollbackBuffer: 'bytes' } },
    });
    expect(refused).toBe(false);
    expect(console.error).toHaveBeenCalledTimes(1);
    const message = String(vi.mocked(console.error).mock.calls[0]?.[0]);
    expect(message).toContain('panel');
    expect(message).toContain(`${PANEL_STATE_CEILING_BYTES} byte ceiling`);
    expect(message).toMatch(/\$\.customState\.initialInput \(\d+ bytes\)/);

    // Nothing from the refused write landed: state, title, or buffers.
    expect(db.getPanel('panel')?.state.customState).toEqual({ cwd: tempDir, initialInput: accepted });
    expect(db.getPanel('panel')?.title).toBe('Terminal');
    expect(db.getPanelBuffers('panel')).toBeNull();

    expect(() => db.createPanel({
      id: 'oversized', sessionId: 'session', type: 'terminal', title: 'Terminal',
      state: { isActive: false, customState: { initialInput: 'z'.repeat(300 * 1024) } },
    })).toThrow(/ceiling/);
    expect(db.getPanel('oversized')).toBeNull();
  });

  it('caps a panel at 4 MB, trimming the oldest scrollback first, with one warning per panel', () => {
    const line = `${'x'.repeat(1023)}\n`;
    const scrollback = line.repeat(5 * 1024); // 5 MiB
    db.createPanel({
      id: 'panel', sessionId: 'session', type: 'terminal', title: 'Terminal',
      state: { isActive: false, customState: { scrollbackBuffer: scrollback, alternateScreenBuffer: 'alt' } },
    });

    const stored = db.getPanelBuffers('panel');
    const storedScrollback = stored?.scrollback ?? '';
    const storedBytes = Buffer.byteLength(storedScrollback, 'utf8') + Buffer.byteLength(stored?.alternate ?? '', 'utf8');
    expect(storedBytes).toBeLessThanOrEqual(PANEL_BUFFER_CAP_BYTES);
    expect(storedBytes).toBeGreaterThan(PANEL_BUFFER_CAP_BYTES - 2048);
    expect(scrollback.endsWith(storedScrollback)).toBe(true);
    expect(storedScrollback.startsWith('x')).toBe(true);
    expect(stored?.alternate).toBe('alt');
    expect(decodeBoundary(
      db.getDb().prepare('SELECT bytes FROM panel_buffers WHERE panel_id = ?').get('panel'),
      bytesSchema,
    ).bytes).toBe(storedBytes);

    expect(console.warn).toHaveBeenCalledTimes(1);
    const warning = String(vi.mocked(console.warn).mock.calls[0]?.[0]);
    expect(warning).toContain('panel');
    expect(warning).toContain(`${PANEL_BUFFER_CAP_BYTES} byte cap`);

    // A second oversize write on the same panel trims again but stays quiet.
    expect(db.updatePanel('panel', { state: { isActive: false, customState: { scrollbackBuffer: scrollback } } })).toBe(true);
    expect(Buffer.byteLength(db.getPanelBuffers('panel')?.scrollback ?? '', 'utf8')).toBeLessThanOrEqual(PANEL_BUFFER_CAP_BYTES);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('drops buffers with their panels and sweeps archived sessions', () => {
    for (const id of ['keep', 'drop', 'swept']) {
      db.createPanel({
        id, sessionId: 'session', type: 'terminal', title: 'Terminal',
        state: { isActive: false, customState: { scrollbackBuffer: 'hello' } },
      });
    }
    db.deletePanel('drop');
    expect(db.getPanelBuffers('drop')).toBeNull();
    expect(db.getPanelBuffers('keep')?.scrollback).toBe('hello');

    db.createSession({
      id: 'archived', name: 'archived', initial_prompt: '', worktree_name: 'archived',
      worktree_path: tempDir, project_id: null, tool_type: 'none',
    });
    db.createPanel({
      id: 'old', sessionId: 'archived', type: 'terminal', title: 'Terminal',
      state: { isActive: false, customState: { scrollbackBuffer: 'archived bytes', serializedBuffer: 'snap' } },
    });
    db.archiveSession('archived');

    const result = new ScrollbackRetentionService(db).runRetentionSweep();
    expect(result).toEqual({ panelsCleared: 1, sessionsTouched: 1, bytesFreed: 'archived bytes'.length + 'snap'.length });
    expect(db.getPanelBuffers('old')).toBeNull();
    expect(db.getPanelBuffers('keep')?.scrollback).toBe('hello');

    db.deletePanelsForSession('session');
    expect(db.getPanelBuffers('keep')).toBeNull();
  });
});
