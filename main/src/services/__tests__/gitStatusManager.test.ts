import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { GitStatusManager } from '../gitStatusManager';
import { execSync } from '../../utils/commandExecutor';
import { existsSync } from 'fs';
import { fastCheckWorkingDirectory, fastGetAheadBehind, fastGetDiffStats } from '../gitPlumbingCommands';
import type { SessionManager } from '../sessionManager';
import type { WorktreeManager } from '../worktreeManager';
import type { GitDiffManager } from '../gitDiffManager';
import type { Logger } from '../../utils/logger';
import type { GitStatus } from '../../types/session';
import type { GitIndexStatus } from '../gitPlumbingCommands';

// Type for accessing private members in tests
interface GitStatusManagerPrivates {
  fetchGitStatus(sessionId: string): Promise<GitStatus | null>;
  cache: Record<string, { status: GitStatus; lastChecked: number }>;
}

// Mock modules
vi.mock('../../utils/commandExecutor');
vi.mock('fs');
vi.mock('../gitPlumbingCommands');
vi.mock('../gitStatusLogger', () => ({
  GitStatusLogger: vi.fn().mockImplementation(() => ({
    logPollStart: vi.fn(),
    logSessionFetch: vi.fn(),
    logSessionSuccess: vi.fn(),
    logSessionError: vi.fn(),
    logFocusChange: vi.fn(),
    logSummary: vi.fn(),
    logDebounce: vi.fn(),
    logPollComplete: vi.fn(),
  })),
}));
vi.mock('../gitFileWatcher', () => ({
  GitFileWatcher: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    startWatching: vi.fn(),
    stopWatching: vi.fn(),
    stopAll: vi.fn(),
  })),
}));

const mockSession = {
  id: 'test-session',
  worktreePath: '/test/worktree',
  archived: false,
  projectId: 1,
};

const mockProject = {
  id: 1,
  path: '/test/project',
};

const mockProjectContext = {
  project: mockProject,
  pathResolver: {},
  commandRunner: { execAsync: vi.fn() },
};

const cleanIndexStatus: GitIndexStatus = {
  hasModified: false,
  hasStaged: false,
  hasUntracked: false,
  hasConflicts: false,
};

describe('GitStatusManager', () => {
  let gitStatusManager: GitStatusManager;
  let mockSessionManager: SessionManager;
  let mockWorktreeManager: WorktreeManager;
  let mockGitDiffManager: GitDiffManager;
  let mockLogger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSessionManager = {
      getSession: vi.fn().mockResolvedValue(mockSession),
      getProjectContext: vi.fn().mockReturnValue(mockProjectContext),
      getProjectForSession: vi.fn().mockReturnValue(mockProject),
      getAllSessions: vi.fn().mockResolvedValue([]),
    } as Partial<SessionManager> as SessionManager;

    mockWorktreeManager = {
      getProjectMainBranch: vi.fn().mockResolvedValue('main'),
    } as Partial<WorktreeManager> as WorktreeManager;

    mockGitDiffManager = {} as Partial<GitDiffManager> as GitDiffManager;

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
    } as Partial<Logger> as Logger;

    gitStatusManager = new GitStatusManager(
      mockSessionManager,
      mockWorktreeManager,
      mockGitDiffManager,
      mockLogger
    );

    // Default mocks: no rebase in progress
    (existsSync as Mock).mockReturnValue(false);

    // Default: no uncommitted changes, no ahead/behind
    (fastCheckWorkingDirectory as Mock).mockReturnValue(cleanIndexStatus);
    (fastGetAheadBehind as Mock).mockReturnValue({ ahead: 0, behind: 0 });
    (fastGetDiffStats as Mock).mockReturnValue({ additions: 0, deletions: 0, filesChanged: 0 });

    // Default execSync returns empty buffer
    (execSync as Mock).mockReturnValue(Buffer.from(''));
  });

  describe('fetchGitStatus via getGitStatus (cache miss scenarios)', () => {
    it('returns clean state when no changes, no ahead/behind, no untracked', async () => {
      (fastCheckWorkingDirectory as Mock).mockReturnValue(cleanIndexStatus);
      (fastGetAheadBehind as Mock).mockReturnValue({ ahead: 0, behind: 0 });

      const status = await (gitStatusManager as unknown as GitStatusManagerPrivates).fetchGitStatus('test-session');

      expect(status).not.toBeNull();
      expect(status!.state).toBe('clean');
      expect(status!.ahead).toBeUndefined();
      expect(status!.behind).toBeUndefined();
      expect(status!.hasUncommittedChanges).toBe(false);
      expect(status!.hasUntrackedFiles).toBe(false);
    });

    it('returns modified state when uncommitted changes exist', async () => {
      (fastCheckWorkingDirectory as Mock).mockReturnValue({
        hasModified: true,
        hasStaged: false,
        hasUntracked: false,
        hasConflicts: false,
      });
      (fastGetDiffStats as Mock).mockReturnValue({ additions: 15, deletions: 5, filesChanged: 3 });
      (fastGetAheadBehind as Mock).mockReturnValue({ ahead: 0, behind: 0 });

      const status = await (gitStatusManager as unknown as GitStatusManagerPrivates).fetchGitStatus('test-session');

      expect(status!.state).toBe('modified');
      expect(status!.hasUncommittedChanges).toBe(true);
      expect(status!.filesChanged).toBe(3);
      expect(status!.additions).toBe(15);
      expect(status!.deletions).toBe(5);
    });

    it('returns ahead state when commits ahead of main', async () => {
      (fastCheckWorkingDirectory as Mock).mockReturnValue(cleanIndexStatus);
      (fastGetAheadBehind as Mock).mockReturnValue({ ahead: 3, behind: 0 });
      (execSync as Mock).mockImplementation((cmd: string) => {
        if ((cmd as string).includes('diff --shortstat')) {
          return Buffer.from(' 5 files changed, 20 insertions(+), 10 deletions(-)');
        }
        if ((cmd as string).includes('rev-list --count')) {
          return Buffer.from('3');
        }
        return Buffer.from('');
      });

      const status = await (gitStatusManager as unknown as GitStatusManagerPrivates).fetchGitStatus('test-session');

      expect(status!.state).toBe('ahead');
      expect(status!.ahead).toBe(3);
      expect(status!.totalCommits).toBe(3);
      expect(status!.isReadyToMerge).toBe(true);
      expect(status!.commitFilesChanged).toBe(5);
      expect(status!.commitAdditions).toBe(20);
      expect(status!.commitDeletions).toBe(10);
    });

    it('returns behind state when commits behind main', async () => {
      (fastCheckWorkingDirectory as Mock).mockReturnValue(cleanIndexStatus);
      (fastGetAheadBehind as Mock).mockReturnValue({ ahead: 0, behind: 5 });

      const status = await (gitStatusManager as unknown as GitStatusManagerPrivates).fetchGitStatus('test-session');

      expect(status!.state).toBe('behind');
      expect(status!.behind).toBe(5);
      expect(status!.ahead).toBeUndefined();
    });

    it('returns diverged state when both ahead and behind', async () => {
      (fastCheckWorkingDirectory as Mock).mockReturnValue(cleanIndexStatus);
      (fastGetAheadBehind as Mock).mockReturnValue({ ahead: 2, behind: 3 });
      (execSync as Mock).mockImplementation((cmd: string) => {
        if ((cmd as string).includes('diff --shortstat')) {
          return Buffer.from(' 4 files changed, 15 insertions(+), 8 deletions(-)');
        }
        if ((cmd as string).includes('rev-list --count')) {
          return Buffer.from('2');
        }
        return Buffer.from('');
      });

      const status = await (gitStatusManager as unknown as GitStatusManagerPrivates).fetchGitStatus('test-session');

      expect(status!.state).toBe('diverged');
      expect(status!.ahead).toBe(2);
      expect(status!.behind).toBe(3);
    });

    it('returns conflict state when merge conflicts exist', async () => {
      (fastCheckWorkingDirectory as Mock).mockReturnValue({
        hasModified: false,
        hasStaged: false,
        hasUntracked: false,
        hasConflicts: true,
      });
      (fastGetAheadBehind as Mock).mockReturnValue({ ahead: 0, behind: 0 });

      const status = await (gitStatusManager as unknown as GitStatusManagerPrivates).fetchGitStatus('test-session');

      expect(status!.state).toBe('conflict');
    });

    it('returns untracked state when only untracked files exist', async () => {
      (fastCheckWorkingDirectory as Mock).mockReturnValue({
        hasModified: false,
        hasStaged: false,
        hasUntracked: true,
        hasConflicts: false,
      });
      (fastGetAheadBehind as Mock).mockReturnValue({ ahead: 0, behind: 0 });

      const status = await (gitStatusManager as unknown as GitStatusManagerPrivates).fetchGitStatus('test-session');

      expect(status!.state).toBe('untracked');
      expect(status!.hasUntrackedFiles).toBe(true);
    });

    it('returns null when session is not found', async () => {
      (mockSessionManager.getSession as Mock).mockResolvedValue(null);

      const status = await (gitStatusManager as unknown as GitStatusManagerPrivates).fetchGitStatus('test-session');

      expect(status).toBeNull();
    });

    it('sets modified as primary state and ahead as secondary when uncommitted changes and ahead', async () => {
      (fastCheckWorkingDirectory as Mock).mockReturnValue({
        hasModified: true,
        hasStaged: false,
        hasUntracked: false,
        hasConflicts: false,
      });
      (fastGetDiffStats as Mock).mockReturnValue({ additions: 5, deletions: 2, filesChanged: 2 });
      (fastGetAheadBehind as Mock).mockReturnValue({ ahead: 2, behind: 0 });
      (execSync as Mock).mockImplementation((cmd: string) => {
        if ((cmd as string).includes('diff --shortstat')) {
          return Buffer.from(' 3 files changed, 10 insertions(+), 5 deletions(-)');
        }
        if ((cmd as string).includes('rev-list --count')) {
          return Buffer.from('2');
        }
        return Buffer.from('');
      });

      const status = await (gitStatusManager as unknown as GitStatusManagerPrivates).fetchGitStatus('test-session');

      expect(status!.state).toBe('modified');
      expect(status!.secondaryStates).toContain('ahead');
    });
  });

  describe('caching', () => {
    it('returns cached status within TTL without re-fetching', async () => {
      const cachedStatus: GitStatus = { state: 'clean', lastChecked: new Date().toISOString() };
      (gitStatusManager as unknown as GitStatusManagerPrivates).cache['test-session'] = {
        status: cachedStatus,
        lastChecked: Date.now(),
      };

      const fetchSpy = vi.spyOn(
        gitStatusManager as unknown as GitStatusManagerPrivates,
        'fetchGitStatus'
      );

      const result = await gitStatusManager.getGitStatus('test-session');

      expect(result).toEqual(cachedStatus);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches fresh status after TTL has expired', async () => {
      const expiredStatus: GitStatus = { state: 'clean', lastChecked: new Date().toISOString() };
      (gitStatusManager as unknown as GitStatusManagerPrivates).cache['test-session'] = {
        status: expiredStatus,
        lastChecked: Date.now() - 10000, // 10s ago — beyond the 5s TTL
      };

      const freshStatus: GitStatus = { state: 'modified', lastChecked: new Date().toISOString() };
      vi.spyOn(
        gitStatusManager as unknown as GitStatusManagerPrivates,
        'fetchGitStatus'
      ).mockResolvedValue(freshStatus);

      const result = await gitStatusManager.getGitStatus('test-session');

      expect(result).toEqual(freshStatus);
    });
  });

  describe('lifecycle methods', () => {
    it('startPolling does not throw', () => {
      expect(() => gitStatusManager.startPolling()).not.toThrow();
    });

    it('stopPolling does not throw', () => {
      expect(() => gitStatusManager.stopPolling()).not.toThrow();
    });
  });
});
