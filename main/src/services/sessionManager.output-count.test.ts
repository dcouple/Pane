import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database';
import { SessionManager } from './sessionManager';

describe('prompt marker output counts', () => {
  it('preserves marker offsets across all output types without reading history payloads', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-prompt-count-'));
    const db = new DatabaseService(path.join(tempDir, 'sessions.db'));
    const manager = new SessionManager(db);
    try {
      db.initialize();
      for (const id of ['target', 'other']) {
        db.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: tempDir, project_id: null, tool_type: 'none' });
      }
      expect(db.getSessionOutputCount('target')).toBe(0);
      expect(db.getSessionOutputCount('missing')).toBe(0);
      db.addSessionOutput('other', 'stdout', 'unrelated output');
      for (const type of ['stdout', 'stderr', 'system', 'json', 'error'] as const) {
        db.addSessionOutput('target', type, 'x'.repeat(64 * 1024));
      }
      const historyRead = vi.spyOn(db, 'getSessionOutputs').mockImplementation(() => {
        throw new Error('Prompt markers must not load output payloads');
      });

      manager.addSessionOutput('target', {
        type: 'json', data: { type: 'user', message: { content: 'new prompt' } }, timestamp: new Date(),
      });
      expect(db.getSessionOutputCount('target')).toBe(6);
      expect(db.getPromptMarkers('target').map(marker => marker.output_index)).toEqual([5]);

      await manager.continueConversation('target', 'follow-up');
      expect(db.getSessionOutputCount('target')).toBe(7);
      expect(db.getPromptMarkers('target').map(marker => marker.output_index)).toEqual([5, 7]);
      expect(historyRead).not.toHaveBeenCalled();
      db.clearSessionOutputs('target');
      expect(db.getSessionOutputCount('target')).toBe(0);
      expect(db.getSessionOutputCount('other')).toBe(1);
    } finally {
      await manager.cleanup();
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
