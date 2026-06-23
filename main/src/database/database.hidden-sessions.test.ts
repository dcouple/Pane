import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database';

const tempDirs: string[] = [];

function createTestDatabase(): { db: DatabaseService; tempDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-hidden-sessions-'));
  tempDirs.push(tempDir);
  const db = new DatabaseService(path.join(tempDir, 'sessions.db'));
  db.initialize();
  return { db, tempDir };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('hidden sessions', () => {
  it('allows detached hidden sessions and filters them from normal session lists', () => {
    const { db, tempDir } = createTestDatabase();
    const project = db.createProject('Repo', path.join(tempDir, 'repo'));

    db.createSession({
      id: 'visible-session',
      name: 'Visible Session',
      initial_prompt: '',
      worktree_name: 'visible',
      worktree_path: path.join(tempDir, 'repo'),
      project_id: project.id,
      tool_type: 'claude',
    });

    const hidden = db.createSession({
      id: 'hidden-session',
      name: 'Hidden Session',
      initial_prompt: '',
      worktree_name: 'hidden',
      worktree_path: tempDir,
      project_id: null,
      tool_type: 'none',
      is_hidden: true,
    });

    expect(hidden.project_id).toBeNull();
    expect(Boolean(hidden.is_hidden)).toBe(true);

    expect(db.getAllSessions().map(session => session.id)).toEqual(['visible-session']);
    expect(db.getAllSessions(undefined, { includeHidden: true }).map(session => session.id).sort()).toEqual([
      'hidden-session',
      'visible-session',
    ]);

    db.archiveSession('hidden-session');
    expect(db.getArchivedSessions().map(session => session.id)).toEqual([]);
    expect(db.getArchivedSessions(undefined, { includeHidden: true }).map(session => session.id).sort()).toEqual([
      'hidden-session',
    ]);

    db.close();
  });
});
