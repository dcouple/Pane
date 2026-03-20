import { IpcMain } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';
import type { AppServices } from './types';
import { buildGitCommitCommand } from '../utils/shellEscape';
import { mainWindow } from '../index';
import { panelEventBus } from '../services/panelEventBus';
import { PanelEventType, ToolPanelType, PanelEvent } from '../../../shared/types/panels';
import type { Session } from '../types/session';
import type { GitCommit, GitGraphCommit } from '../services/gitDiffManager';
import { CommandRunner } from '../utils/commandRunner';
import { getShellPath } from '../utils/shellPath';
import { parseWSLPath, validateWSLAvailable } from '../utils/wslUtils';

// Extended type for git system virtual panels
type SystemPanelType = ToolPanelType | 'git';

// Interface for custom git errors that contain additional context
interface GitError extends Error {
  gitCommands?: string[];
  gitOutput?: string;
  workingDirectory?: string;
  projectPath?: string;
  originalError?: Error;
}

// Interface for process errors that have stdout/stderr properties
interface ProcessError {
  stdout?: string;
  stderr?: string;
  message?: string;
}

// Interface for generic error objects with git-related properties
interface ErrorWithGitContext {
  gitCommand?: string;
  gitCommands?: string[];
  gitOutput?: string;
  workingDirectory?: string;
  originalError?: Error;
  [key: string]: unknown;
}

// Interface for raw commit data from worktreeManager
interface RawCommitData {
  hash: string;
  message: string;
  date: string | Date;
  author?: string;
  additions?: number;
  deletions?: number;
  filesChanged?: number;
}


function isValidGitUrl(url: string): boolean {
  // Accept https://, ssh://, and scp-style git@host:path formats
  return /^(https?:\/\/[\w.\-\/:@]+|ssh:\/\/[\w.\-\/:@]+|git@[\w.\-]+:[\w.\-\/]+)(\.git)?$/.test(url);
}

function extractRepoName(url: string): string {
  const cleaned = url.replace(/\/+$/, '').replace(/\.git$/, '');
  const lastSegment = cleaned.split('/').pop() || cleaned.split(':').pop() || 'repo';
  return lastSegment;
}

export function registerGitHandlers(ipcMain: IpcMain, services: AppServices): void {
  const { sessionManager, gitDiffManager, worktreeManager, claudeCodeManager, gitStatusManager, databaseService } = services;

  // Helper function to emit git operation events to all sessions in a project
  const emitGitOperationToProject = (sessionId: string, eventType: PanelEventType, message: string, details?: Record<string, unknown>) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session) return;
      
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) return;
      
      // Create a virtual event as if it came from the git system
      const event = {
        type: eventType,
        source: {
          panelId: 'git-system', // Special panel ID for git operations
          panelType: 'git' as SystemPanelType, // Virtual panel type
          sessionId: sessionId // The session that triggered the operation
        },
        data: {
          message,
          triggeringSessionId: sessionId,
          triggeringSessionName: session.name,
          projectId: project.id,
          ...details
        },
        timestamp: new Date().toISOString()
      };
      
      // Emit the event once to the panel event bus
      // All Claude panels that have subscribed will receive it
      panelEventBus.emitPanelEvent(event as PanelEvent);

      // Also forward to renderer so UI components listening for window 'panel:event' receive it
      try {
        if (mainWindow) {
          mainWindow.webContents.send('panel:event', event);
        }
      } catch (ipcError) {
        console.error('[Git] Failed to forward git operation event to renderer:', ipcError);
      }
    } catch (emitError) {
      console.error('[Git] Failed to emit git operation event:', emitError);
    }
  };

  // Helper function to refresh git status after operations that only affect one session
  const refreshGitStatusForSession = async (sessionId: string, isUserInitiated = false) => {
    try {
      await gitStatusManager.refreshSessionGitStatus(sessionId, isUserInitiated);
    } catch {
      // Git status refresh failures are logged by GitStatusManager
    }
  };

  // Helper function to refresh git status for all sessions in a project (e.g. after updating main)
  const refreshGitStatusForProject = async (projectId: number) => {
    try {
      const sessions = await sessionManager.getAllSessions();
      const projectSessions = sessions.filter(s => s.projectId === projectId && !s.archived && s.status !== 'error');
      
      // Refresh all sessions in parallel
      await Promise.all(projectSessions.map(session =>
        gitStatusManager.refreshSessionGitStatus(session.id, false).catch(() => {
          // Individual failures are logged by GitStatusManager
        })
      ));
    } catch {
      // Project-level refresh failures are rare and will be logged by GitStatusManager
    }
  };

  const getSessionCommitHistory = async (
    session: Session,
    limit: number = 50
  ): Promise<{
    commits: GitCommit[];
    mainBranch: string;
    comparisonBranch: string;
    historySource: 'remote' | 'local' | 'branch';
    limitReached: boolean;
  }> => {
    if (!session.worktreePath) {
      throw new Error('Session has no worktree path');
    }

    const project = sessionManager.getProjectForSession(session.id);
    if (!project?.path) {
      throw new Error('Project path not found for session');
    }

    const ctx = sessionManager.getProjectContext(session.id);
    if (!ctx) throw new Error('Project context not found for session');

    const mainBranch = await worktreeManager.getProjectMainBranch(project.path, ctx.commandRunner);
    let comparisonBranch = mainBranch;
    let historySource: 'remote' | 'local' | 'branch' = 'branch';
    let useFallback = false;

    if (session.isMainRepo) {
      const originBranch = await worktreeManager.getOriginBranch(session.worktreePath, mainBranch, ctx.commandRunner);
      if (originBranch) {
        comparisonBranch = originBranch;
        historySource = 'remote';
      } else {
        historySource = 'local';
        comparisonBranch = mainBranch;
        useFallback = true;
      }
    }

    let commits: GitCommit[] = [];

    if (!useFallback) {
      try {
        commits = gitDiffManager.getCommitHistory(session.worktreePath, limit, comparisonBranch, ctx.commandRunner);
      } catch (error) {
        if (session.isMainRepo) {
          console.warn(`[IPC:git] Falling back to local commit history for session ${session.id}:`, error);
          useFallback = true;
          historySource = 'local';
          comparisonBranch = mainBranch;
        } else {
          throw error;
        }
      }
    }

    if (useFallback) {
      const fallbackLimit = limit;
      const fallbackCommits = await worktreeManager.getLastCommits(session.worktreePath, fallbackLimit, ctx.commandRunner);
      commits = fallbackCommits.map((commit: RawCommitData) => ({
        hash: commit.hash,
        message: commit.message,
        date: new Date(commit.date),
        author: commit.author || 'Unknown',
        stats: {
          additions: commit.additions || 0,
          deletions: commit.deletions || 0,
          filesChanged: commit.filesChanged || 0
        }
      }));
    }

    if (!session.isMainRepo) {
      historySource = 'branch';
    }

    const limitReached = commits.length === limit;

    return {
      commits,
      mainBranch,
      comparisonBranch,
      historySource,
      limitReached
    };
  };

  ipcMain.handle('sessions:get-executions', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const { commits, comparisonBranch, historySource, limitReached } = await getSessionCommitHistory(session, 50);

      // Transform git commits to execution format expected by frontend
      const executions = commits.map((commit, index) => ({
        id: index + 1, // 1-based index for commits
        session_id: sessionId,
        execution_sequence: index + 1,
        after_commit_hash: commit.hash,
        commit_message: commit.message,
        timestamp: commit.date.toISOString(),
        stats_additions: commit.stats.additions,
        stats_deletions: commit.stats.deletions,
        stats_files_changed: commit.stats.filesChanged,
        author: commit.author,
        comparison_branch: comparisonBranch,
        history_source: historySource,
        history_limit_reached: limitReached
      }));

      // Check for uncommitted changes
      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const hasUncommittedChanges = gitDiffManager.hasChanges(session.worktreePath, ctx.commandRunner);
      if (hasUncommittedChanges) {
        // Get stats for uncommitted changes
        const uncommittedDiff = await gitDiffManager.captureWorkingDirectoryDiff(session.worktreePath, ctx.commandRunner);
        
        // Add uncommitted changes as execution with id 0
        executions.unshift({
          id: 0,
          session_id: sessionId,
          execution_sequence: 0,
          after_commit_hash: 'UNCOMMITTED',
          commit_message: 'Uncommitted changes',
          timestamp: new Date().toISOString(),
          stats_additions: uncommittedDiff.stats.additions,
          stats_deletions: uncommittedDiff.stats.deletions,
          stats_files_changed: uncommittedDiff.stats.filesChanged,
          author: 'You',
          comparison_branch: comparisonBranch,
          history_source: historySource,
          history_limit_reached: limitReached
        });
      }

      return { success: true, data: executions };
    } catch (error) {
      console.error('Failed to get executions:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to get executions';
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle('sessions:get-execution-diff', async (_event, sessionId: string, executionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const { commits } = await getSessionCommitHistory(session, 50);
      const executionIndex = parseInt(executionId) - 1;

      if (executionIndex < 0 || executionIndex >= commits.length) {
        return { success: false, error: 'Invalid execution ID' };
      }

      // Get diff for the specific commit
      const commit = commits[executionIndex];
      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const diff = gitDiffManager.getCommitDiff(session.worktreePath, commit.hash, ctx.commandRunner);
      return { success: true, data: diff };
    } catch (error) {
      console.error('Failed to get execution diff:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to get execution diff';
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle('sessions:get-git-graph', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const project = sessionManager.getProjectForSession(sessionId);
      if (!project?.path) {
        return { success: false, error: 'Project path not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const mainBranch = await worktreeManager.getProjectMainBranch(project.path, ctx.commandRunner);
      let branch: string;
      try {
        branch = ctx.commandRunner.exec('git rev-parse --abbrev-ref HEAD', session.worktreePath).trim() || session.baseBranch || 'unknown';
      } catch {
        branch = session.baseBranch || 'unknown';
      }

      let entries: GitGraphCommit[] = [];
      let useFallback = false;

      if (session.isMainRepo) {
        const originBranch = await worktreeManager.getOriginBranch(session.worktreePath, mainBranch, ctx.commandRunner);
        if (!originBranch) {
          useFallback = true;
        }
      }

      if (!useFallback) {
        try {
          const comparisonBranch = session.isMainRepo
            ? (await worktreeManager.getOriginBranch(session.worktreePath, mainBranch, ctx.commandRunner)) || mainBranch
            : mainBranch;
          entries = gitDiffManager.getGraphCommitHistory(session.worktreePath, branch, 50, comparisonBranch, ctx.commandRunner);
          if (entries.length === 0 && session.isMainRepo) {
            useFallback = true;
          }
        } catch (error) {
          if (session.isMainRepo) {
            useFallback = true;
          } else {
            throw error;
          }
        }
      }

      if (useFallback) {
        const fallbackCommits = await worktreeManager.getLastCommits(session.worktreePath, 50, ctx.commandRunner);
        entries = fallbackCommits.map((commit: RawCommitData, index: number, arr: RawCommitData[]) => ({
          hash: commit.hash.substring(0, 7),
          parents: index < arr.length - 1 ? [arr[index + 1].hash.substring(0, 7)] : [],
          branch,
          message: commit.message,
          committerDate: new Date(commit.date).toISOString(),
          author: commit.author || 'Unknown',
        }));
      }

      // Prepend uncommitted changes if any
      const hasUncommittedChanges = gitDiffManager.hasChanges(session.worktreePath, ctx.commandRunner);
      if (hasUncommittedChanges) {
        // Get diff stats for uncommitted changes
        let filesChanged = 0;
        let additions = 0;
        let deletions = 0;
        try {
          const combinedStat = ctx.commandRunner.exec('git diff HEAD --shortstat', session.worktreePath).trim();
          if (combinedStat) {
            const fileMatch = combinedStat.match(/(\d+) files? changed/);
            const addMatch = combinedStat.match(/(\d+) insertions?\(\+\)/);
            const delMatch = combinedStat.match(/(\d+) deletions?\(-\)/);
            filesChanged = fileMatch ? parseInt(fileMatch[1]) : 0;
            additions = addMatch ? parseInt(addMatch[1]) : 0;
            deletions = delMatch ? parseInt(delMatch[1]) : 0;
          }
        } catch {
          // Ignore stat errors — still show the entry without stats
        }

        entries.unshift({
          hash: 'index',
          parents: entries.length > 0 ? [entries[0].hash] : [],
          branch,
          message: 'Uncommitted changes',
          committerDate: new Date().toISOString(),
          author: 'You',
          filesChanged,
          additions,
          deletions,
        });
      }

      return { success: true, data: { entries, currentBranch: branch } };
    } catch (error) {
      console.error('Failed to get git graph:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to get git graph';
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle('sessions:git-commit', async (_event, sessionId: string, message: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Check if there are any changes to commit
      const status = ctx.commandRunner.exec('git status --porcelain', session.worktreePath).trim();

      if (!status) {
        return { success: false, error: 'No changes to commit' };
      }

      // Stage all changes
      ctx.commandRunner.exec('git add -A', session.worktreePath);

      // Create the commit with Pane's signature using safe escaping
      const commitCommand = buildGitCommitCommand(message);

      try {
        ctx.commandRunner.exec(commitCommand, session.worktreePath);

        // Refresh git status for this session after commit
        await refreshGitStatusForSession(sessionId);

        return { success: true };
      } catch (commitError: unknown) {
        // Check if it's a pre-commit hook failure
        if ((commitError && typeof commitError === 'object' && 'stdout' in commitError && (commitError as ProcessError).stdout?.includes('pre-commit')) || (commitError && typeof commitError === 'object' && 'stderr' in commitError && (commitError as ProcessError).stderr?.includes('pre-commit'))) {
          return { success: false, error: 'Pre-commit hooks failed. Please fix the issues and try again.' };
        }
        throw commitError;
      }
    } catch (error: unknown) {
      console.error('Failed to commit changes:', error);
      const errorMessage = (error instanceof Error ? error.message : '') || (error && typeof error === 'object' && 'stderr' in error ? (error as ProcessError).stderr : '') || 'Failed to commit changes';
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle('git:file-status', async (_event, sessionId: string, filePath: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session not found' };
      }
      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) return { success: false, error: 'No project context' };

      // Check working tree + staged changes for this specific file
      const modified = ctx.commandRunner.exec(
        `git diff --name-only HEAD -- "${filePath}"`,
        session.worktreePath
      ).trim();

      // Check if file is untracked
      const untracked = ctx.commandRunner.exec(
        `git ls-files --others --exclude-standard -- "${filePath}"`,
        session.worktreePath
      ).trim();

      const status = untracked.length > 0 ? 'untracked' : modified.length > 0 ? 'modified' : 'clean';
      return { success: true, data: { status } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check file status' };
    }
  });

  ipcMain.handle('sessions:git-diff', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      // Check if session is archived - worktree won't exist
      if (session.archived) {
        return { success: false, error: 'Cannot access git diff for archived session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const diff = await gitDiffManager.getGitDiff(session.worktreePath, ctx.commandRunner);
      return { success: true, data: diff };
    } catch (error) {
      // Don't log errors for expected failures
      const errorMessage = error instanceof Error ? error.message : 'Failed to get git diff';
      if (!errorMessage.includes('archived session')) {
        console.error('Failed to get git diff:', error);
      }
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle('sessions:get-commit-diff-by-hash', async (_event, sessionId: string, commitHash: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      if (session.archived) {
        return { success: false, error: 'Cannot access git diff for archived session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      if (commitHash === 'index') {
        const data = await gitDiffManager.captureWorkingDirectoryDiff(session.worktreePath, ctx.commandRunner);
        return { success: true, data };
      }

      const data = gitDiffManager.getCommitDiff(session.worktreePath, commitHash, ctx.commandRunner);
      return { success: true, data };
    } catch (error) {
      console.error('Failed to get commit diff by hash:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to get commit diff';
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle('sessions:get-combined-diff', async (_event, sessionId: string, executionIds?: number[]) => {
    try {
      // Get session to find worktree path
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      // Handle uncommitted changes request
      if (executionIds && executionIds.length === 1 && executionIds[0] === 0) {
        const ctx = sessionManager.getProjectContext(sessionId);
        if (!ctx) throw new Error('Project context not found for session');

        // Verify the worktree exists and has uncommitted changes
        try {
          ctx.commandRunner.exec('git status --porcelain', session.worktreePath);
        } catch (statusError) {
          console.error('Error checking git status:', statusError);
        }

        const uncommittedDiff = await gitDiffManager.captureWorkingDirectoryDiff(session.worktreePath, ctx.commandRunner);
        return { success: true, data: uncommittedDiff };
      }

      const { commits } = await getSessionCommitHistory(session, 50);

      if (!commits.length) {
        return {
          success: true,
          data: {
            diff: '',
            stats: { additions: 0, deletions: 0, filesChanged: 0 },
            changedFiles: []
          }
        };
      }

      // If we have a range selection (2 IDs), use git diff between them
      if (executionIds && executionIds.length === 2) {
        const sortedIds = [...executionIds].sort((a, b) => a - b);

        // Handle range that includes uncommitted changes
        if (sortedIds[0] === 0 || sortedIds[1] === 0) {
          const ctx = sessionManager.getProjectContext(sessionId);
          if (!ctx) throw new Error('Project context not found for session');

          // If uncommitted is in the range, get diff from the other commit to working directory
          const commitId = sortedIds[0] === 0 ? sortedIds[1] : sortedIds[0];
          const commitIndex = commitId - 1;

          if (commitIndex >= 0 && commitIndex < commits.length) {
            const fromCommit = commits[commitIndex];
            // Get diff from commit to working directory (includes uncommitted changes)
            const maxBuffer = 10 * 1024 * 1024;
            const diff = ctx.commandRunner.exec(
              `git diff ${fromCommit.hash}`,
              session.worktreePath,
              { maxBuffer }
            );

            const stats = gitDiffManager.parseDiffStats(
              ctx.commandRunner.exec(`git diff --stat ${fromCommit.hash}`, session.worktreePath, { maxBuffer })
            );

            const changedFiles = ctx.commandRunner.exec(
              `git diff --name-only ${fromCommit.hash}`,
              session.worktreePath,
              { maxBuffer }
            ).trim().split('\n').filter(Boolean);

            return {
              success: true,
              data: {
                diff,
                stats,
                changedFiles,
                beforeHash: fromCommit.hash,
                afterHash: 'UNCOMMITTED'
              }
            };
          }
        }

        // For regular commit ranges, we want to show all changes introduced by the selected commits
        // - Commits are stored newest first (index 0 = newest)
        // - User selects from older to newer visually
        // - We need to go back one commit before the older selection to show all changes
        const newerIndex = sortedIds[0] - 1;   // Lower ID = newer commit
        const olderIndex = sortedIds[1] - 1;   // Higher ID = older commit

        if (newerIndex >= 0 && newerIndex < commits.length && olderIndex >= 0 && olderIndex < commits.length) {
          const newerCommit = commits[newerIndex]; // Newer commit
          const olderCommit = commits[olderIndex]; // Older commit

          // To show all changes introduced by the selected commits, we diff from
          // the parent of the older commit to the newer commit
          let fromCommitHash: string;

          const ctx = sessionManager.getProjectContext(sessionId);
          if (!ctx) throw new Error('Project context not found for session');

          try {
            // Try to get the parent of the older commit
            const parentHash = ctx.commandRunner.exec(`git rev-parse ${olderCommit.hash}^`, session.worktreePath).trim();
            fromCommitHash = parentHash;
          } catch {
            // If there's no parent (initial commit), use git's empty tree hash
            fromCommitHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
          }

          // Use git diff to show all changes from before the range to the newest selected commit
          const diff = await gitDiffManager.captureCommitDiff(
            session.worktreePath,
            fromCommitHash,
            newerCommit.hash,
            ctx.commandRunner
          );
          return { success: true, data: diff };
        }
      }

      // If no specific execution IDs are provided, get all diffs including uncommitted changes
      if (!executionIds || executionIds.length === 0) {
        const ctx = sessionManager.getProjectContext(sessionId);
        if (!ctx) throw new Error('Project context not found for session');

        if (commits.length === 0) {
          // No commits, but there might be uncommitted changes
          const uncommittedDiff = await gitDiffManager.captureWorkingDirectoryDiff(session.worktreePath, ctx.commandRunner);
          return { success: true, data: uncommittedDiff };
        }

        // For a single commit, show changes from before the commit to working directory
        if (commits.length === 1) {
          let fromCommitHash: string;
          try {
            // Try to get the parent of the commit
            fromCommitHash = ctx.commandRunner.exec(`git rev-parse ${commits[0].hash}^`, session.worktreePath).trim();
          } catch {
            // If there's no parent (initial commit), use git's empty tree hash
            fromCommitHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
          }

          // Get diff from parent to working directory (includes the commit and any uncommitted changes)
          const maxBuffer = 10 * 1024 * 1024;
          const diff = ctx.commandRunner.exec(
            `git diff ${fromCommitHash}`,
            session.worktreePath,
            { maxBuffer }
          );

          const stats = gitDiffManager.parseDiffStats(
            ctx.commandRunner.exec(`git diff --stat ${fromCommitHash}`, session.worktreePath, { maxBuffer })
          );

          const changedFiles = ctx.commandRunner.exec(
            `git diff --name-only ${fromCommitHash}`,
            session.worktreePath,
            { maxBuffer }
          ).trim().split('\n').filter(f => f);

          return {
            success: true,
            data: {
              diff,
              stats,
              changedFiles
            }
          };
        }

        // For multiple commits, get diff from parent of first commit to working directory (all changes including uncommitted)
        const firstCommit = commits[commits.length - 1]; // Oldest commit
        let fromCommitHash: string;

        try {
          // Try to get the parent of the first commit
          fromCommitHash = ctx.commandRunner.exec(`git rev-parse ${firstCommit.hash}^`, session.worktreePath).trim();
        } catch {
          // If there's no parent (initial commit), use git's empty tree hash
          fromCommitHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
        }

        // Get diff from the parent of first commit to working directory (includes uncommitted changes)
        const maxBuffer = 10 * 1024 * 1024;
        const diff = ctx.commandRunner.exec(
          `git diff ${fromCommitHash}`,
          session.worktreePath,
          { maxBuffer }
        );

        const stats = gitDiffManager.parseDiffStats(
          ctx.commandRunner.exec(`git diff --stat ${fromCommitHash}`, session.worktreePath, { maxBuffer })
        );

        const changedFiles = ctx.commandRunner.exec(
          `git diff --name-only ${fromCommitHash}`,
          session.worktreePath,
          { maxBuffer }
        ).trim().split('\n').filter(f => f);

        return {
          success: true,
          data: {
            diff,
            stats,
            changedFiles
          }
        };
      }

      // For multiple individual selections, we need to create a range from first to last
      if (executionIds.length > 2) {
        const sortedIds = [...executionIds].sort((a, b) => a - b);
        const firstId = sortedIds[sortedIds.length - 1]; // Highest ID = oldest commit
        const lastId = sortedIds[0]; // Lowest ID = newest commit

        const fromIndex = firstId - 1;
        const toIndex = lastId - 1;

        if (fromIndex >= 0 && fromIndex < commits.length && toIndex >= 0 && toIndex < commits.length) {
          const fromCommit = commits[fromIndex]; // Oldest selected
          const toCommit = commits[toIndex]; // Newest selected

          const ctx = sessionManager.getProjectContext(sessionId);
          if (!ctx) throw new Error('Project context not found for session');

          const diff = await gitDiffManager.captureCommitDiff(
            session.worktreePath,
            fromCommit.hash,
            toCommit.hash,
            ctx.commandRunner
          );
          return { success: true, data: diff };
        }
      }

      // Single commit selection (but not uncommitted changes)
      if (executionIds.length === 1 && executionIds[0] !== 0) {
        const commitIndex = executionIds[0] - 1;
        if (commitIndex >= 0 && commitIndex < commits.length) {
          const commit = commits[commitIndex];
          const ctx = sessionManager.getProjectContext(sessionId);
          if (!ctx) throw new Error('Project context not found for session');

          const diff = gitDiffManager.getCommitDiff(session.worktreePath, commit.hash, ctx.commandRunner);
          return { success: true, data: diff };
        }
      }

      // Fallback to empty diff
      return {
        success: true,
        data: {
          diff: '',
          stats: { additions: 0, deletions: 0, filesChanged: 0 },
          changedFiles: []
        }
      };
    } catch (error) {
      console.error('Failed to get combined diff:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to get combined diff';
      return { success: false, error: errorMessage };
    }
  });

  // Git rebase operations
  ipcMain.handle('sessions:check-rebase-conflicts', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the project to find the main branch
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Always get the current branch from the project directory
      const mainBranch = await worktreeManager.getProjectMainBranch(project.path, ctx.commandRunner);

      // Check for conflicts
      const conflictInfo = await worktreeManager.checkForRebaseConflicts(session.worktreePath, mainBranch, ctx.commandRunner);

      return {
        success: true,
        data: conflictInfo
      };
    } catch (error: unknown) {
      console.error(`[IPC:git] Failed to check for rebase conflicts:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check for rebase conflicts'
      };
    }
  });

  ipcMain.handle('sessions:rebase-main-into-worktree', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the project to find the main branch
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Get the main branch from the project directory's current branch
      const mainBranch = await Promise.race([
        worktreeManager.getProjectMainBranch(project.path, ctx.commandRunner),
        new Promise((_, reject) => setTimeout(() => reject(new Error('getProjectMainBranch timeout')), 30000))
      ]) as string;

      // Check for conflicts before attempting rebase
      const conflictCheck = await worktreeManager.checkForRebaseConflicts(session.worktreePath, mainBranch, ctx.commandRunner);
      
      if (conflictCheck.hasConflicts) {
        
        // Build detailed error message
        let errorMessage = `Rebase would result in conflicts. Cannot proceed automatically.\n\n`;
        
        if (conflictCheck.conflictingFiles && conflictCheck.conflictingFiles.length > 0) {
          errorMessage += `Conflicting files:\n`;
          conflictCheck.conflictingFiles.forEach(file => {
            errorMessage += `  • ${file}\n`;
          });
          errorMessage += '\n';
        }
        
        if (conflictCheck.conflictingCommits) {
          if (conflictCheck.conflictingCommits.ours.length > 0) {
            errorMessage += `Your commits:\n`;
            conflictCheck.conflictingCommits.ours.slice(0, 5).forEach(commit => {
              errorMessage += `  ${commit}\n`;
            });
            if (conflictCheck.conflictingCommits.ours.length > 5) {
              errorMessage += `  ... and ${conflictCheck.conflictingCommits.ours.length - 5} more\n`;
            }
            errorMessage += '\n';
          }
          
          if (conflictCheck.conflictingCommits.theirs.length > 0) {
            errorMessage += `Incoming commits from ${mainBranch}:\n`;
            conflictCheck.conflictingCommits.theirs.slice(0, 5).forEach(commit => {
              errorMessage += `  ${commit}\n`;
            });
            if (conflictCheck.conflictingCommits.theirs.length > 5) {
              errorMessage += `  ... and ${conflictCheck.conflictingCommits.theirs.length - 5} more\n`;
            }
          }
        }
        
        // Emit git operation failed event for conflict detection
        const conflictMessage = `✗ Rebase aborted: Conflicts detected\n\n${errorMessage}`;
        emitGitOperationToProject(sessionId, 'git:operation_failed', conflictMessage, {
          operation: 'rebase_from_main',
          mainBranch,
          hasConflicts: true,
          conflictingFiles: conflictCheck.conflictingFiles
        });
        
        // Return detailed conflict information
        return {
          success: false,
          error: 'Rebase would result in conflicts',
          gitError: {
            command: `git rebase ${mainBranch}`,
            output: errorMessage,
            workingDirectory: session.worktreePath,
            hasConflicts: true,
            conflictingFiles: conflictCheck.conflictingFiles,
            conflictingCommits: conflictCheck.conflictingCommits
          }
        };
      }

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nRebasing from ${mainBranch}...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'rebase_from_main',
        mainBranch
      });

      await Promise.race([
        worktreeManager.rebaseMainIntoWorktree(session.worktreePath, mainBranch, ctx.commandRunner),
        new Promise((_, reject) => setTimeout(() => reject(new Error('rebaseMainIntoWorktree timeout')), 120000))
      ]);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully rebased ${mainBranch} into worktree`;
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'rebase_from_main',
        mainBranch
      });

      // Update git status directly after rebasing from main (more efficient than refresh)
      // Don't let this block the response - run it in background
      gitStatusManager.updateGitStatusAfterRebase(sessionId, 'from_main').catch(error => {
        console.error(`[IPC:git] Failed to update git status for session ${sessionId}:`, error);
      });

      return { success: true, data: { message: `Successfully rebased ${mainBranch} into worktree` } };
    } catch (error: unknown) {
      console.error(`[IPC:git] Failed to rebase main into worktree for session ${sessionId}:`, error);

      // Emit git operation failed event
      const errorMessage = `✗ Rebase failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (error && typeof error === 'object' && 'gitOutput' in error && (error as GitError).gitOutput ? `\n\nGit output:\n${(error as GitError).gitOutput}` : '');
      
      // Don't let this block the error response either
      try {
        emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
          operation: 'rebase_from_main',
          error: error instanceof Error ? error.message : String(error),
          gitOutput: error && typeof error === 'object' && 'gitOutput' in error ? (error as GitError).gitOutput : undefined
        });
      } catch (outputError) {
        console.error(`[IPC:git] Failed to emit git error event for session ${sessionId}:`, outputError);
      }

      // Pass detailed git error information to frontend
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to rebase main into worktree',
        gitError: {
          command: error && typeof error === 'object' && 'gitCommand' in error ? (error as ErrorWithGitContext).gitCommand : undefined,
          output: error && typeof error === 'object' && 'gitOutput' in error ? (error as ErrorWithGitContext).gitOutput : (error instanceof Error ? error.message : String(error)),
          workingDirectory: error && typeof error === 'object' && 'workingDirectory' in error ? (error as ErrorWithGitContext).workingDirectory : undefined,
          originalError: error && typeof error === 'object' && 'originalError' in error ? (error as ErrorWithGitContext).originalError?.message : undefined
        }
      };
    }
  });

  ipcMain.handle('sessions:abort-rebase-and-use-claude', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the project to find the main branch
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Get the main branch from the project directory's current branch
      const mainBranch = await worktreeManager.getProjectMainBranch(project.path, ctx.commandRunner);

      // Check if we're actually in a rebase state (could have been pre-detected conflicts)
      // Try to abort any existing rebase, but don't fail if there isn't one
      try {
        const statusOutput = ctx.commandRunner.exec('git status --porcelain=v1', session.worktreePath);
        if (statusOutput.includes('rebase')) {
          await worktreeManager.abortRebase(session.worktreePath, ctx.commandRunner);

          // Emit git operation event about aborting the rebase
          const abortMessage = `🔄 GIT OPERATION\nAborted rebase successfully`;
          emitGitOperationToProject(sessionId, 'git:operation_completed', abortMessage, {
            operation: 'abort_rebase'
          });
        }
      } catch {
        // Not in a rebase state or already clean - that's fine
      }

      // Use session-based Claude to handle the rebase and conflicts
      const prompt = `Please rebase the local ${mainBranch} branch (not origin/${mainBranch}) into this branch and resolve all conflicts`;

      try {
        // Start Claude session to handle rebase
        await claudeCodeManager.startSession(
          sessionId,
          session.worktreePath,
          prompt,
          session.permissionMode,
          session.model
        );

        // Add message to session output
        const message = `🤖 CLAUDE CODE\nStarted Claude session to handle rebase and resolve conflicts\nPrompt: ${prompt}`;
        sessionManager.addSessionOutput(sessionId, {
          type: 'stdout',
          data: message,
          timestamp: new Date()
        });

        return {
          success: true,
          data: {
            message: 'Claude Code session started to handle rebase and resolve conflicts'
          }
        };
      } catch (error: unknown) {
        console.error('[IPC:git] Failed to start Claude session:', error);

        let errorMessage = 'Failed to start Claude session';
        if (error instanceof Error && error.message) {
          errorMessage = `Failed to start Claude session: ${error.message}`;
        }

        return { success: false, error: errorMessage };
      }
    } catch (error: unknown) {
      console.error('[IPC:git] Failed to abort rebase and use Claude:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to abort rebase and use Claude'
      };
    }
  });

  ipcMain.handle('sessions:squash-and-rebase-to-main', async (_event, sessionId: string, commitMessage: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the project to find the main branch and project path
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Get the effective main branch (override or auto-detected)
      const mainBranch = await Promise.race([
        worktreeManager.getProjectMainBranch(project.path, ctx.commandRunner),
        new Promise((_, reject) => setTimeout(() => reject(new Error('getProjectMainBranch timeout')), 30000))
      ]) as string;

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nSquashing commits and merging to ${mainBranch}...\nCommit message: ${commitMessage.split('\n')[0]}${commitMessage.includes('\n') ? '...' : ''}`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'squash_and_merge',
        mainBranch,
        commitMessage: commitMessage.split('\n')[0]
      });

      await Promise.race([
        worktreeManager.squashAndMergeWorktreeToMain(project.path, session.worktreePath, mainBranch, commitMessage, ctx.commandRunner),
        new Promise((_, reject) => setTimeout(() => reject(new Error('squashAndMergeWorktreeToMain timeout')), 180000))
      ]);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully squashed and merged worktree to ${mainBranch}`;
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'squash_and_merge',
        mainBranch
      });

      // Update git status for ALL sessions in the project since main was updated
      // Wait for this to complete before returning so UI sees the updated status immediately
      if (session.projectId !== undefined) {
        try {
          await gitStatusManager.updateProjectGitStatusAfterMainUpdate(session.projectId, sessionId);
        } catch (error) {
          console.error(`[IPC:git] Failed to update git status for project ${session.projectId}:`, error);
          // Continue even if status update fails - the merge succeeded
        }
      }

      return { success: true, data: { message: `Successfully squashed and merged worktree to ${mainBranch}` } };
    } catch (error: unknown) {
      console.error(`[IPC:git] Failed to squash and merge worktree to main for session ${sessionId}:`, error);

      // Emit git operation failed event
      const errorMessage = `✗ Merge failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (error && typeof error === 'object' && 'gitOutput' in error && (error as GitError).gitOutput ? `\n\nGit output:\n${(error as GitError).gitOutput}` : '');

      // Don't let this block the error response either
      try {
        emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
          operation: 'squash_and_merge',
          error: error instanceof Error ? error.message : String(error),
          gitOutput: error && typeof error === 'object' && 'gitOutput' in error ? (error as GitError).gitOutput : undefined
        });
      } catch (outputError) {
        console.error(`[IPC:git] Failed to emit git error event for session ${sessionId}:`, outputError);
      }

      // Pass detailed git error information to frontend
      const gitError = error as GitError;
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to squash and merge worktree to main',
        gitError: {
          commands: gitError.gitCommands,
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory,
          projectPath: gitError.projectPath,
          originalError: gitError.originalError?.message
        }
      };
    }
  });

  ipcMain.handle('sessions:rebase-to-main', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the project to find the main branch and project path
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Get the effective main branch (override or auto-detected)
      const mainBranch = await worktreeManager.getProjectMainBranch(project.path, ctx.commandRunner);

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nMerging to ${mainBranch} (preserving all commits)...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'merge_to_main',
        mainBranch
      });

      await worktreeManager.mergeWorktreeToMain(project.path, session.worktreePath, mainBranch, ctx.commandRunner);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully merged worktree to ${mainBranch}`;
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'merge_to_main',
        mainBranch
      });
      sessionManager.addSessionOutput(sessionId, {
        type: 'stdout',
        data: successMessage,
        timestamp: new Date()
      });

      // Update git status for ALL sessions in the project since main was updated
      // Wait for this to complete before returning so UI sees the updated status immediately
      if (session.projectId !== undefined) {
        try {
          await gitStatusManager.updateProjectGitStatusAfterMainUpdate(session.projectId, sessionId);
        } catch (error) {
          console.error(`[IPC:git] Failed to update git status for project ${session.projectId}:`, error);
          // Continue even if status update fails - the merge succeeded
        }
      }

      return { success: true, data: { message: `Successfully merged worktree to ${mainBranch}` } };
    } catch (error: unknown) {
      console.error('Failed to merge worktree to main:', error);

      const gitError = error as GitError;

      // Add error message to session output
      const errorMessage = `✗ Merge failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      sessionManager.addSessionOutput(sessionId, {
        type: 'stderr',
        data: errorMessage,
        timestamp: new Date()
      });
      // Pass detailed git error information to frontend
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to merge worktree to main',
        gitError: {
          commands: gitError.gitCommands,
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory,
          projectPath: gitError.projectPath,
          originalError: gitError.originalError?.message
        }
      };
    }
  });

  // Git pull/push operations for main repo sessions
  ipcMain.handle('sessions:git-pull', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nPulling latest changes from remote...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'pull'
      });

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Run git pull
      const result = await worktreeManager.gitPull(session.worktreePath, ctx.commandRunner);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully pulled latest changes` +
                            (result.output ? `\n\nGit output:\n${result.output}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'pull',
        output: result.output
      });

      // Check if this is a main repo session pulling main branch updates
      if (session.isMainRepo && session.projectId !== undefined) {
        // If pulling to main repo, all worktrees might be affected
        await refreshGitStatusForProject(session.projectId);
      } else {
        // If pulling to a worktree, only this session is affected
        await refreshGitStatusForSession(sessionId);
      }

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to pull from remote:', error);

      // Emit git operation failed event
      const gitError = error as GitError;
      
      const errorMessage = `✗ Pull failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'pull',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput
      });

      // Check if it's a merge conflict
      if ((error instanceof Error && error.message?.includes('CONFLICT')) || (gitError.gitOutput?.includes('CONFLICT'))) {
        return {
          success: false,
          error: 'Merge conflicts detected. Please resolve conflicts manually or ask Claude to help.',
          isMergeConflict: true,
          gitError: {
            output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
            workingDirectory: gitError.workingDirectory || ''
          }
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to pull from remote',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  ipcMain.handle('sessions:git-push', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nPushing changes to remote...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'push'
      });

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Run git push
      const result = await worktreeManager.gitPush(session.worktreePath, ctx.commandRunner);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully pushed changes to remote` +
                            (result.output ? `\n\nGit output:\n${result.output}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'push',
        output: result.output
      });
      sessionManager.addSessionOutput(sessionId, {
        type: 'stdout',
        data: successMessage,
        timestamp: new Date()
      });

      // Invalidate PR cache after push since PRs may have been created or updated
      const pushProject = sessionManager.getProjectForSession(sessionId);
      if (pushProject?.path) {
        gitStatusManager.invalidatePrCache(pushProject.path);
      }

      // Check if this is a main repo session pushing to main branch
      if (session.isMainRepo && session.projectId !== undefined) {
        // If pushing from main repo, all worktrees might be affected
        await refreshGitStatusForProject(session.projectId);
      } else {
        // If pushing from a worktree, only this session is affected
        await refreshGitStatusForSession(sessionId);
      }

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to push to remote:', error);

      const gitError = error as GitError;
      
      // Emit git operation failed event
      const errorMessage = `✗ Push failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'push',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to push to remote',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  ipcMain.handle('sessions:git-soft-reset', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event
      const startMessage = `🔄 GIT OPERATION\nUndoing last commit (keeping changes staged)...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'soft-reset'
      });

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Use session's base commit as the undo boundary — this ensures only commits
      // created within this session can be undone, not pre-existing branch commits.
      // Falls back to main branch if base_commit isn't recorded.
      let undoBoundary = session.baseCommit;
      if (!undoBoundary) {
        const project = sessionManager.getProjectForSession(sessionId);
        if (!project?.path) throw new Error('Project path not found for session');
        undoBoundary = await worktreeManager.getProjectMainBranch(project.path, ctx.commandRunner);
      }

      // Run git soft reset with live safety check against the undo boundary
      const result = await worktreeManager.gitSoftReset(session.worktreePath, undoBoundary, ctx.commandRunner);

      // Emit git operation completed event
      const successMessage = `✓ Successfully undid last commit (changes are now staged)\n\nPrevious commit message:\n${result.previousCommitMessage}`;
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'soft-reset',
        previousCommitMessage: result.previousCommitMessage
      });

      // Refresh git status
      if (session.isMainRepo && session.projectId !== undefined) {
        await refreshGitStatusForProject(session.projectId);
      } else {
        await refreshGitStatusForSession(sessionId);
      }

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to soft reset:', error);

      const gitError = error as GitError;

      const errorMessage = `✗ Undo commit failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'soft-reset',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to undo commit',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  ipcMain.handle('sessions:git-fetch', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event
      const startMessage = `🔄 GIT OPERATION\nFetching from remote...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'fetch'
      });

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Run git fetch
      const result = await worktreeManager.gitFetch(session.worktreePath, ctx.commandRunner);

      // Emit git operation completed event
      const successMessage = `✓ Successfully fetched from remote` +
                            (result.output ? `\n\nGit output:\n${result.output}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'fetch',
        output: result.output
      });

      // Refresh git status after fetch (may show new commits behind)
      await refreshGitStatusForSession(sessionId);

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to fetch from remote:', error);

      const gitError = error as GitError;

      // Emit git operation failed event
      const errorMessage = `✗ Fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'fetch',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch from remote',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  ipcMain.handle('sessions:git-stash', async (_event, sessionId: string, message?: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event
      const startMessage = `🔄 GIT OPERATION\nStashing changes...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'stash'
      });

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Run git stash
      const result = await worktreeManager.gitStash(session.worktreePath, message, ctx.commandRunner);

      // Emit git operation completed event
      const successMessage = `✓ Successfully stashed changes` +
                            (result.output ? `\n\nGit output:\n${result.output}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'stash',
        output: result.output
      });

      // Refresh git status after stash
      await refreshGitStatusForSession(sessionId);

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to stash changes:', error);

      const gitError = error as GitError;

      // Emit git operation failed event
      const errorMessage = `✗ Stash failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'stash',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stash changes',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  ipcMain.handle('sessions:git-stash-pop', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event
      const startMessage = `🔄 GIT OPERATION\nPopping stash...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'stash_pop'
      });

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Run git stash pop
      const result = await worktreeManager.gitStashPop(session.worktreePath, ctx.commandRunner);

      // Emit git operation completed event
      const successMessage = `✓ Successfully applied stash` +
                            (result.output ? `\n\nGit output:\n${result.output}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'stash_pop',
        output: result.output
      });

      // Refresh git status after stash pop
      await refreshGitStatusForSession(sessionId);

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to pop stash:', error);

      const gitError = error as GitError;

      // Emit git operation failed event
      const errorMessage = `✗ Stash pop failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'stash_pop',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to pop stash',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  ipcMain.handle('sessions:has-stash', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const hasStash = await worktreeManager.hasStash(session.worktreePath, ctx.commandRunner);
      return { success: true, data: hasStash };
    } catch (error: unknown) {
      console.error('Failed to check stash:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check stash'
      };
    }
  });

  ipcMain.handle('sessions:set-upstream', async (_event, sessionId: string, remoteBranch: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const result = await worktreeManager.setUpstream(session.worktreePath, remoteBranch, ctx.commandRunner);

      // Refresh git status after setting upstream
      await refreshGitStatusForSession(sessionId);

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to set upstream:', error);
      const gitError = error as GitError;
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set upstream',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  ipcMain.handle('sessions:get-upstream', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const upstream = await worktreeManager.getUpstream(session.worktreePath, ctx.commandRunner);
      return { success: true, data: upstream };
    } catch (error: unknown) {
      console.error('Failed to get upstream:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get upstream'
      };
    }
  });

  ipcMain.handle('sessions:get-remote-branches', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const branches = await worktreeManager.getRemoteBranches(session.worktreePath, ctx.commandRunner);
      return { success: true, data: branches };
    } catch (error: unknown) {
      console.error('Failed to get remote branches:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get remote branches'
      };
    }
  });

  ipcMain.handle('sessions:git-stage-and-commit', async (_event, sessionId: string, message: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event
      const startMessage = `🔄 GIT OPERATION\nCommitting changes...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'commit',
        message: message.split('\n')[0]
      });

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Run git add -A && git commit
      const result = await worktreeManager.gitStageAllAndCommit(session.worktreePath, message, ctx.commandRunner);

      // Emit git operation completed event
      const successMessage = `✓ Successfully committed changes` +
                            (result.output ? `\n\nGit output:\n${result.output}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'commit',
        output: result.output
      });

      // Refresh git status after commit
      await refreshGitStatusForSession(sessionId);

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to commit changes:', error);

      const gitError = error as GitError;

      // Emit git operation failed event
      const errorMessage = `✗ Commit failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'commit',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to commit changes',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  ipcMain.handle('sessions:get-last-commits', async (_event, sessionId: string, count: number = 50) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Get the last N commits from the repository
      const commits = await worktreeManager.getLastCommits(session.worktreePath, count, ctx.commandRunner);
      const limitReached = commits.length === count;

      // Transform commits to match ExecutionDiff format
      const executionDiffs = commits.map((commit, index) => ({
        id: index + 1,
        session_id: sessionId,
        commit_message: commit.message,
        execution_sequence: index + 1,
        stats_additions: commit.additions || 0,
        stats_deletions: commit.deletions || 0,
        stats_files_changed: commit.filesChanged || 0,
        commit_hash: commit.hash,
        timestamp: commit.date,
        author: commit.author || 'Unknown',
        history_limit_reached: limitReached
      }));

      return { success: true, data: executionDiffs };
    } catch (error: unknown) {
      console.error('Failed to get last commits:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get last commits'
      };
    }
  });

  // Git operation helpers
  ipcMain.handle('sessions:has-changes-to-rebase', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Get the effective main branch (override or auto-detected)
      const mainBranch = await worktreeManager.getProjectMainBranch(project.path, ctx.commandRunner);
      const hasChanges = await worktreeManager.hasChangesToRebase(session.worktreePath, mainBranch, ctx.commandRunner);

      return { success: true, data: hasChanges };
    } catch (error) {
      console.error('Failed to check for changes to rebase:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check for changes to rebase' };
    }
  });

  ipcMain.handle('sessions:get-git-commands', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      // Check if session is archived - worktree won't exist
      if (session.archived) {
        return { success: false, error: 'Cannot access git commands for archived session' };
      }

      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Get the effective main branch (override or auto-detected)
      const mainBranch = await worktreeManager.getProjectMainBranch(project.path, ctx.commandRunner);

      // Get current branch name
      const currentBranch = ctx.commandRunner.exec('git branch --show-current', session.worktreePath).trim();

      const originBranch = session.isMainRepo
        ? await worktreeManager.getOriginBranch(session.worktreePath, mainBranch, ctx.commandRunner)
        : null;

      const rebaseCommands = worktreeManager.generateRebaseCommands(mainBranch);
      const squashCommands = worktreeManager.generateSquashCommands(mainBranch, currentBranch);
      const mergeCommands = worktreeManager.generateMergeCommands(mainBranch, currentBranch);

      return {
        success: true,
        data: {
          rebaseCommands,
          squashCommands,
          mergeCommands,
          mainBranch,
          originBranch: originBranch || undefined,
          currentBranch
        }
      };
    } catch (error) {
      // Don't log errors for expected failures
      const errorMessage = error instanceof Error ? error.message : 'Failed to get git commands';
      if (!errorMessage.includes('archived session')) {
        console.error('Failed to get git commands:', error);
      }
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle('sessions:get-git-status', async (_event, sessionId: string, nonBlocking?: boolean, isInitialLoad?: boolean) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      if (session.archived) {
        return { success: false, error: 'Cannot get git status for archived session' };
      }

      // For initial loads, use the queued approach to prevent UI lock
      if (isInitialLoad) {
        const cachedStatus = await gitStatusManager.queueInitialLoad(sessionId);
        return {
          success: true,
          gitStatus: cachedStatus,
          backgroundRefresh: true
        };
      }

      // If nonBlocking is true, start refresh in background and return immediately
      if (nonBlocking) {
        // Start the refresh in background
        setImmediate(() => {
          gitStatusManager.refreshSessionGitStatus(sessionId, true).catch(error => {
            console.error(`[Git] Background git status refresh failed for session ${sessionId}:`, error);
          });
        });

        // Return the cached status if available, or indicate background refresh started
        const cachedStatus = await gitStatusManager.getGitStatus(sessionId);
        return {
          success: true,
          gitStatus: cachedStatus,
          backgroundRefresh: true
        };
      } else {
        // Use refreshSessionGitStatus with user-initiated flag
        // This is called when user clicks on a session, so show loading state
        const gitStatus = await gitStatusManager.refreshSessionGitStatus(sessionId, true);
        return { success: true, gitStatus };
      }
    } catch (error) {
      console.error('Error getting git status:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('git:cancel-status-for-project', async (_event, projectId: number) => {
    try {
      // Get all sessions for the project
      const sessions = await sessionManager.getAllSessions();
      const projectSessions = sessions.filter(s => s.projectId === projectId && !s.archived);

      // Cancel git status operations for all project sessions
      const sessionIds = projectSessions.map(s => s.id);
      gitStatusManager.cancelMultipleGitStatus(sessionIds);

      return { success: true };
    } catch (error) {
      console.error('Error cancelling git status:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('git:get-github-remote', async (_event, sessionId: string) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: true, data: null };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) return { success: true, data: null };

      const stdout = ctx.commandRunner.exec('git remote -v', session.worktreePath);

      // Parse remote output for github.com
      const lines = stdout.split('\n');
      for (const line of lines) {
        // Match SSH format: git@github.com:org/repo.git (repo can contain dots like repo.name)
        const sshMatch = line.match(/git@github\.com:([^/]+\/[^\s]+?)(?:\.git)?(?:\s|$)/);
        if (sshMatch) {
          // Remove .git suffix if present
          const repo = sshMatch[1].replace(/\.git$/, '');
          return { success: true, data: `https://github.com/${repo}` };
        }

        // Match HTTPS format: https://github.com/org/repo.git or https://github.com/org/repo
        const httpsMatch = line.match(/https:\/\/github\.com\/([^/]+\/[^\s]+?)(?:\.git)?(?:\s|$)/);
        if (httpsMatch) {
          // Remove .git suffix if present
          const repo = httpsMatch[1].replace(/\.git$/, '');
          return { success: true, data: `https://github.com/${repo}` };
        }
      }

      return { success: true, data: null };
    } catch (error) {
      console.error('Failed to get GitHub remote:', error);
      return { success: true, data: null }; // Silent fail, just no git links
    }
  });

  ipcMain.handle('git:clone-repo', async (_event, url: string, destDir: string) => {
    if (!isValidGitUrl(url)) {
      return { success: false, error: 'Invalid repository URL. Use https:// or git@ format.' };
    }

    const repoName = extractRepoName(url);

    // Detect WSL path (e.g. \\wsl$\Ubuntu\home\user) and configure accordingly
    const wslInfo = parseWSLPath(destDir);
    let actualDestDir = destDir;
    let wslEnabled = false;
    let wslDistribution: string | null = null;

    if (wslInfo) {
      const wslError = validateWSLAvailable(wslInfo.distro);
      if (wslError) {
        return { success: false, error: wslError };
      }
      wslEnabled = true;
      wslDistribution = wslInfo.distro;
      actualDestDir = wslInfo.linuxPath;
    }

    const clonePath = wslEnabled ? `${actualDestDir}/${repoName}` : join(destDir, repoName);
    const fsCheckPath = wslEnabled ? join(destDir, repoName) : clonePath;

    if (existsSync(fsCheckPath)) {
      return { success: false, error: `Directory "${repoName}" already exists in the destination folder` };
    }

    try {
      // Use double quotes for cross-platform compatibility (single quotes break on Windows cmd.exe)
      const escapedUrl = url.replace(/"/g, '\\"');
      const escapedPath = clonePath.replace(/"/g, '\\"');
      const commandRunner = new CommandRunner({ path: actualDestDir, wsl_enabled: wslEnabled, wsl_distribution: wslDistribution });
      await commandRunner.execAsync(
        `git clone "${escapedUrl}" "${escapedPath}"`,
        actualDestDir,
        { timeout: 300000, env: { ...process.env, PATH: getShellPath() } as Record<string, string> }
      );

      // Return the original (non-WSL-translated) path so the frontend can use it directly
      const returnPath = wslEnabled ? join(destDir, repoName) : clonePath;
      return { success: true, data: { clonedPath: returnPath, repoName } };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (errorMsg.includes('Could not resolve host') || errorMsg.includes('Connection timed out')) {
        return { success: false, error: 'Network error — check your internet connection and try again.' };
      }
      if (errorMsg.includes('Authentication failed') || errorMsg.includes('could not read Username')) {
        return { success: false, error: 'Authentication failed — check your credentials or use an SSH URL.' };
      }
      if (errorMsg.includes('not found') || errorMsg.includes('does not exist')) {
        return { success: false, error: 'Repository not found — check the URL and try again.' };
      }

      return { success: false, error: errorMsg };
    }
  });
}
