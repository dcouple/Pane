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

describe('session favorite pinning persistence', () => {
  it('preserves declarative pin state and timestamp across database reopens', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-favorite-pinning-'));
    tempDirs.push(tempDir);
    const databasePath = path.join(tempDir, 'sessions.db');

    const first = new DatabaseService(databasePath);
    first.initialize();
    const project = first.createProject('Repo', path.join(tempDir, 'repo'));
    first.createSession({
      id: 'pinned-session',
      name: 'Pinned Session',
      initial_prompt: '',
      worktree_name: 'pinned-session',
      worktree_path: path.join(tempDir, 'repo-pinned-session'),
      project_id: project.id,
      tool_type: 'none',
    });

    const pinned = first.setSessionFavorite('pinned-session', true);
    const pinnedAgain = first.setSessionFavorite('pinned-session', true);
    expect(Boolean(pinned?.is_favorite)).toBe(true);
    expect(pinned?.favorite_pinned_at).not.toBeNull();
    expect(pinnedAgain?.favorite_pinned_at).toBe(pinned?.favorite_pinned_at);
    first.close();

    const second = new DatabaseService(databasePath);
    second.initialize();
    expect(Boolean(second.getSession('pinned-session')?.is_favorite)).toBe(true);
    expect(second.getSession('pinned-session')?.favorite_pinned_at).toBe(pinned?.favorite_pinned_at);

    const unpinned = second.setSessionFavorite('pinned-session', false);
    const unpinnedAgain = second.setSessionFavorite('pinned-session', false);
    expect(Boolean(unpinned?.is_favorite)).toBe(false);
    expect(unpinned?.favorite_pinned_at).toBeNull();
    expect(unpinnedAgain?.favorite_pinned_at).toBeNull();
    second.close();

    const third = new DatabaseService(databasePath);
    third.initialize();
    expect(Boolean(third.getSession('pinned-session')?.is_favorite)).toBe(false);
    expect(third.getSession('pinned-session')?.favorite_pinned_at).toBeNull();
    third.close();
  });
});
