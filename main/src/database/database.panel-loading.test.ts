import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { DatabaseService } from './database';

describe('panel history loading', () => {
  it('keeps terminal history out of startup and workspace summaries while preserving restoration', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-panel-loading-'));
    const db = new DatabaseService(path.join(tempDir, 'sessions.db'));
    try {
      db.initialize();
      const history = 'terminal output\r\n'.repeat(65536);
      for (let index = 0; index < 12; index++) {
        const id = `session-${index}`;
        db.createSession({
          id, name: id, initial_prompt: '', worktree_name: id,
          worktree_path: tempDir, project_id: null, tool_type: 'none',
        });
        db.markSessionsAsStopped([id]);
        db.createPanel({
          id: `panel-${index}`, sessionId: id, type: 'terminal', title: 'Terminal',
          state: { isActive: false, customState: {
            scrollbackBuffer: history, serializedBuffer: history,
            cwd: tempDir, isCliPanel: true, agentType: 'claude',
          } },
        });
        if (index % 2 === 0) db.archiveSession(id);
      }
      db.createPanel({ id: 'logs', sessionId: 'session-1', type: 'logs', title: 'Logs' });
      db.createPanel({ id: 'browser', sessionId: 'session-1', type: 'browser', title: 'Browser' });

      expect(db.getPanelsForStartup().map(panel => panel.id).sort()).toEqual(['browser', 'logs']);
      for (let index = 0; index < 12; index++) {
        const summary = db.getPanelsForSession(`session-${index}`, false)[0];
        expect(summary.state.customState).toEqual({ cwd: tempDir, isCliPanel: true, agentType: 'claude' });
        expect(db.getPanel(`panel-${index}`)?.state.customState).toMatchObject({ scrollbackBuffer: history });
      }
      expect(db.getPanelsForSession('session-0')[0].state.customState).toMatchObject({ serializedBuffer: history });
      db.createPanel({
        id: 'legacy', sessionId: 'session-0', type: 'terminal', title: 'Legacy',
        state: JSON.stringify({ isActive: false, customState: { scrollbackBuffer: [history], cwd: tempDir } }),
      });
      expect(db.getPanelsForSession('session-0', false).find(panel => panel.id === 'legacy')?.state.customState)
        .toEqual({ cwd: tempDir });
    } finally {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
