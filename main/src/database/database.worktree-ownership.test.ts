import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database';

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('session worktree ownership', () => {
  it('defaults existing creation paths to pane ownership and persists external ownership', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-worktree-ownership-'));
    tempDirs.push(tempDir);
    const database = new DatabaseService(path.join(tempDir, 'sessions.db'));
    database.initialize();
    const project = database.createProject('Repo', path.join(tempDir, 'repo'));

    const managed = database.createSession({
      id: 'managed', name: 'Managed', initial_prompt: '', worktree_name: 'managed',
      worktree_path: path.join(tempDir, 'managed'), project_id: project.id,
    });
    const external = database.createSession({
      id: 'external', name: 'External', initial_prompt: '', worktree_name: 'external',
      worktree_path: path.join(tempDir, 'external'), project_id: project.id,
      worktree_ownership: 'external', commit_mode: 'disabled',
    });

    expect(managed.worktree_ownership).toBe('pane');
    expect(external.worktree_ownership).toBe('external');
    expect(external.commit_mode).toBe('disabled');
    expect(database.getSessionByWorktreePath(external.worktree_path)?.id).toBe('external');
    database.close();
  });
});
