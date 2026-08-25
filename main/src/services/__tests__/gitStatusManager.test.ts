import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { GitStatusManager } from '../gitStatusManager';
import { execSync } from '../../utils/commandExecutor';
import { fastCheckWorkingDirectory, fastGetAheadBehind, fastGetDiffStats } from '../gitPlumbingCommands';
import type { SessionManager } from '../sessionManager';
import type { WorktreeManager } from '../worktreeManager';
import type { GitDiffManager } from '../gitDiffManager';
import type { Logger } from '../../utils/logger';
import type { GitStatus } from '../../types/session';
import type { GitIndexStatus } from '../gitPlumbingCommands';
import type { CommandRunner } from '../../utils/commandRunner';
import type { DatabaseService } from '../../database/database';

// Type for accessing private members in tests
interface GitStatusManagerPrivates {
  fetchGitStatus(sessionId: string): Promise<GitStatus | null>;
  processInitialLoadQueue(): Promise<void>;
  fetchPrForSession(
    branchName: string,
    projectPath: string,
    commandRunner: CommandRunner
  ): Promise<{ prNumber?: number; prUrl?: string; prTitle?: string; prState?: string; prIsDraft?: boolean; prBody?: string }>;
  enrichWithPrData(sessionId: string): Promise<void>;
  updateCache(sessionId: string, status: GitStatus): GitStatus;
  schedulePrEnrichment(sessionId: string, immediate?: boolean): void;
  cache: Record<string, { status: GitStatus; lastChecked: number }>;
  initialLoadQueue: string[];
  prCache: Map<string, { prNumber?: number; prUrl?: string; prTitle?: string; prState?: string; prIsDraft?: boolean; prBody?: string; fetchedAt: number }>;
  activeSessionId: string | null;
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
  commandRunner: { execAsync: vi.fn(), exec: vi.fn(), wslContext: null },
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
  let mockDatabaseService: Partial<Pick<
    DatabaseService,
    'getAllSessionGitStatusCache' |
    'saveSessionGitStatusCache' |
    'deleteSessionGitStatusCache' |
    'clearSessionGitStatusCache'
  >> & {
    getAllSessionGitStatusCache: Mock;
    saveSessionGitStatusCache: Mock;
    deleteSessionGitStatusCache: Mock;
    clearSessionGitStatusCache: Mock;
  };

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
      getSessionComparisonBranch: vi.fn().mockResolvedValue('main'),
    } as Partial<WorktreeManager> as WorktreeManager;

    mockGitDiffManager = {} as Partial<GitDiffManager> as GitDiffManager;

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
    } as Partial<Logger> as Logger;

    mockDatabaseService = {
      getAllSessionGitStatusCache: vi.fn().mockReturnValue([]),
      saveSessionGitStatusCache: vi.fn(),
      deleteSessionGitStatusCache: vi.fn(),
      clearSessionGitStatusCache: vi.fn(),
    };

    gitStatusManager = new GitStatusManager(
      mockSessionManager,
      mockWorktreeManager,
      mockGitDiffManager,
      mockLogger,
      mockDatabaseService as DatabaseService
    );

    // Default: no uncommitted changes, no ahead/behind
    (fastCheckWorkingDirectory as Mock).mockReturnValue(cleanIndexStatus);
    (fastGetAheadBehind as Mock).mockReturnValue({ ahead: 0, behind: 0 });
    (fastGetDiffStats as Mock).mockReturnValue({ additions: 0, deletions: 0, filesChanged: 0 });

    // Default execSync returns empty buffer
    (execSync as Mock).mockReturnValue(Buffer.from(''));

    // Default commandRunner.exec returns empty string
    (mockProjectContext.commandRunner.exec as Mock).mockReturnValue('');
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
      (mockProjectContext.commandRunner.exec as Mock).mockImplementation((cmd: string) => {
        if (cmd.includes('diff --shortstat')) {
          return ' 5 files changed, 20 insertions(+), 10 deletions(-)';
        }
        if (cmd.includes('rev-list --count')) {
          return '3';
        }
        return '';
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
      (mockProjectContext.commandRunner.exec as Mock).mockImplementation((cmd: string) => {
        if (cmd.includes('diff --shortstat')) {
          return ' 4 files changed, 15 insertions(+), 8 deletions(-)';
        }
        if (cmd.includes('rev-list --count')) {
          return '2';
        }
        return '';
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
      (mockProjectContext.commandRunner.exec as Mock).mockImplementation((cmd: string) => {
        if (cmd.includes('diff --shortstat')) {
          return ' 3 files changed, 10 insertions(+), 5 deletions(-)';
        }
        if (cmd.includes('rev-list --count')) {
          return '2';
        }
        return '';
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

  describe('persistent cache', () => {
    it('hydrates cached statuses from the database on construction', () => {
      const cachedStatus: GitStatus = { state: 'ahead', ahead: 1, lastChecked: '2026-01-01T00:00:00.000Z' };
      mockDatabaseService.getAllSessionGitStatusCache.mockReturnValue([
        { sessionId: 'cached-session', gitStatus: cachedStatus, lastChecked: 1234 },
      ]);

      const manager = new GitStatusManager(
        mockSessionManager,
        mockWorktreeManager,
        mockGitDiffManager,
        mockLogger,
        mockDatabaseService as DatabaseService,
      );
      const privates = manager as unknown as GitStatusManagerPrivates;

      expect(privates.cache['cached-session']).toEqual({
        status: cachedStatus,
        lastChecked: 1234,
      });
    });

    it('persists successful cache updates', () => {
      const privates = gitStatusManager as unknown as GitStatusManagerPrivates;
      const status: GitStatus = { state: 'modified', hasUncommittedChanges: true };

      privates.updateCache('test-session', status);

      expect(mockDatabaseService.saveSessionGitStatusCache).toHaveBeenCalledWith(
        'test-session',
        status,
        expect.any(Number),
      );
    });

    it('preserves cached PR fields when local status refresh has no PR fields', () => {
      const privates = gitStatusManager as unknown as GitStatusManagerPrivates;
      privates.cache['test-session'] = {
        status: {
          state: 'ahead',
          ahead: 1,
          prNumber: 12,
          prUrl: 'https://github.com/example/repo/pull/12',
          prTitle: 'Ready review',
          prState: 'OPEN',
          prIsDraft: true,
          prBody: 'Body',
        },
        lastChecked: Date.now(),
      };

      const updated = privates.updateCache('test-session', {
        state: 'ahead',
        ahead: 2,
        commitAdditions: 20,
      });

      expect(updated).toMatchObject({
        state: 'ahead',
        ahead: 2,
        commitAdditions: 20,
        prNumber: 12,
        prUrl: 'https://github.com/example/repo/pull/12',
        prTitle: 'Ready review',
        prState: 'OPEN',
        prIsDraft: true,
        prBody: 'Body',
      });
      expect(mockDatabaseService.saveSessionGitStatusCache).toHaveBeenLastCalledWith(
        'test-session',
        expect.objectContaining({ prNumber: 12, ahead: 2 }),
        expect.any(Number),
      );
    });
  });

  describe('PR enrichment', () => {
    it('caches PR misses for 20 seconds', async () => {
      const privates = gitStatusManager as unknown as GitStatusManagerPrivates;
      const commandRunner = mockProjectContext.commandRunner;
      (commandRunner.execAsync as Mock).mockResolvedValue({ stdout: '[]' });

      await privates.fetchPrForSession('feature-branch', mockProject.path, commandRunner);
      await privates.fetchPrForSession('feature-branch', mockProject.path, commandRunner);

      expect(commandRunner.execAsync).toHaveBeenCalledTimes(1);

      privates.prCache.set(`${mockProject.path}:feature-branch`, { fetchedAt: Date.now() - 20_001 });

      await privates.fetchPrForSession('feature-branch', mockProject.path, commandRunner);

      expect(commandRunner.execAsync).toHaveBeenCalledTimes(2);
    });

    it('keeps PR hits cached longer than misses', async () => {
      const privates = gitStatusManager as unknown as GitStatusManagerPrivates;
      const commandRunner = mockProjectContext.commandRunner;
      (commandRunner.execAsync as Mock).mockResolvedValue({
        stdout: JSON.stringify([{
          number: 12,
          url: 'https://github.com/example/repo/pull/12',
          title: 'Ready review',
          state: 'OPEN',
          isDraft: true,
          body: 'Body',
        }]),
      });

      await privates.fetchPrForSession('feature-branch', mockProject.path, commandRunner);
      privates.prCache.set(`${mockProject.path}:feature-branch`, {
        prNumber: 12,
        prUrl: 'https://github.com/example/repo/pull/12',
        prTitle: 'Ready review',
        prState: 'OPEN',
        prIsDraft: true,
        prBody: 'Body',
        fetchedAt: Date.now() - 20_001,
      });

      const result = await privates.fetchPrForSession('feature-branch', mockProject.path, commandRunner);

      expect(commandRunner.execAsync).toHaveBeenCalledTimes(1);
      expect(commandRunner.execAsync).toHaveBeenCalledWith(
        expect.stringContaining('isDraft'),
        mockProject.path,
        { timeout: 5000 }
      );
      expect(result.prNumber).toBe(12);
      expect(result.prIsDraft).toBe(true);
    });

    it('invalidates active-session PR misses when the app regains focus', async () => {
      const privates = gitStatusManager as unknown as GitStatusManagerPrivates;
      privates.activeSessionId = 'test-session';
      privates.prCache.set(`${mockProject.path}:feature-branch`, { fetchedAt: Date.now() });
      (mockProjectContext.commandRunner.exec as Mock).mockReturnValue('feature-branch\n');
      const refreshSpy = vi
        .spyOn(gitStatusManager, 'refreshSessionGitStatus')
        .mockResolvedValue({ state: 'clean', lastChecked: new Date().toISOString() });

      gitStatusManager.handleVisibilityChange(false);
      await new Promise(resolve => setImmediate(resolve));

      expect(privates.prCache.has(`${mockProject.path}:feature-branch`)).toBe(false);
      expect(refreshSpy).toHaveBeenCalledWith('test-session', false);
    });

    it('uses the checked-out git branch when enriching PR data', async () => {
      const privates = gitStatusManager as unknown as GitStatusManagerPrivates;
      privates.cache['test-session'] = {
        status: { state: 'ahead', lastChecked: new Date().toISOString() },
        lastChecked: Date.now(),
      };
      (mockSessionManager.getSession as Mock).mockResolvedValue({
        ...mockSession,
        worktreePath: '/test/worktrees/not-the-branch',
      });
      (mockProjectContext.commandRunner.exec as Mock).mockReturnValue('real-feature-branch\n');
      (mockProjectContext.commandRunner.execAsync as Mock).mockResolvedValue({
        stdout: JSON.stringify([{
          number: 12,
          url: 'https://github.com/example/repo/pull/12',
          title: 'Ready review',
          state: 'OPEN',
          isDraft: true,
          body: 'Body',
        }]),
      });

      const updated = new Promise<GitStatus>((resolve) => {
        gitStatusManager.once('git-status-updated', (_sessionId, status) => resolve(status));
      });
      void privates.enrichWithPrData('test-session');
      const status = await updated;

      expect(mockProjectContext.commandRunner.exec).toHaveBeenCalledWith(
        'git branch --show-current',
        '/test/worktrees/not-the-branch',
        { silent: true }
      );
      expect(mockProjectContext.commandRunner.execAsync).toHaveBeenCalledWith(
        expect.stringContaining('real-feature-branch'),
        mockProject.path,
        { timeout: 5000 }
      );
      expect((mockProjectContext.commandRunner.execAsync as Mock).mock.calls[0][0]).not.toContain('not-the-branch');
      expect(status.prNumber).toBe(12);
      expect(status.prUrl).toBe('https://github.com/example/repo/pull/12');
      expect(status.prIsDraft).toBe(true);
    });

    it('clears cached PR fields on a confirmed PR miss', async () => {
      const privates = gitStatusManager as unknown as GitStatusManagerPrivates;
      privates.cache['test-session'] = {
        status: {
          state: 'ahead',
          ahead: 1,
          prNumber: 12,
          prUrl: 'https://github.com/example/repo/pull/12',
          prTitle: 'Ready review',
          prState: 'OPEN',
          prIsDraft: true,
          prBody: 'Body',
        },
        lastChecked: Date.now(),
      };
      (mockProjectContext.commandRunner.exec as Mock).mockReturnValue('feature-branch\n');
      (mockProjectContext.commandRunner.execAsync as Mock).mockResolvedValue({ stdout: '[]' });

      const updated = new Promise<GitStatus>((resolve) => {
        gitStatusManager.once('git-status-updated', (_sessionId, status) => resolve(status));
      });
      void privates.enrichWithPrData('test-session');
      const status = await updated;

      expect(status.prNumber).toBeUndefined();
      expect(status.prUrl).toBeUndefined();
      expect(status.prTitle).toBeUndefined();
      expect(status.prState).toBeUndefined();
      expect(status.prIsDraft).toBeUndefined();
      expect(status.prBody).toBeUndefined();
      expect(status.ahead).toBe(1);
      expect(mockDatabaseService.saveSessionGitStatusCache).toHaveBeenLastCalledWith(
        'test-session',
        expect.not.objectContaining({ prNumber: expect.any(Number) }),
        expect.any(Number),
      );
    });

    it('keeps cached PR fields when PR lookup fails', async () => {
      const privates = gitStatusManager as unknown as GitStatusManagerPrivates;
      const cachedStatus: GitStatus = {
        state: 'ahead',
        ahead: 1,
        prNumber: 12,
        prUrl: 'https://github.com/example/repo/pull/12',
        prTitle: 'Ready review',
        prState: 'OPEN',
        prIsDraft: true,
        prBody: 'Body',
      };
      privates.cache['test-session'] = {
        status: cachedStatus,
        lastChecked: Date.now(),
      };
      (mockProjectContext.commandRunner.exec as Mock).mockReturnValue('feature-branch\n');
      (mockProjectContext.commandRunner.execAsync as Mock).mockRejectedValue(new Error('gh unavailable'));

      await privates.enrichWithPrData('test-session');

      expect(privates.cache['test-session'].status).toEqual(cachedStatus);
      expect(mockDatabaseService.saveSessionGitStatusCache).not.toHaveBeenCalled();
    });

    it('schedules staggered PR enrichment for non-active relevant initial-load status', async () => {
      const privates = gitStatusManager as unknown as GitStatusManagerPrivates;
      privates.initialLoadQueue.push('test-session');
      privates.activeSessionId = null;
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const fetchSpy = vi
        .spyOn(privates, 'fetchGitStatus')
        .mockResolvedValue({ state: 'ahead', ahead: 1, isReadyToMerge: true });
      const scheduleSpy = vi
        .spyOn(privates, 'schedulePrEnrichment')
        .mockImplementation(() => {});

      await privates.processInitialLoadQueue();

      expect(fetchSpy).toHaveBeenCalledWith('test-session');
      expect(scheduleSpy).toHaveBeenCalledWith('test-session', false);
      randomSpy.mockRestore();
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
