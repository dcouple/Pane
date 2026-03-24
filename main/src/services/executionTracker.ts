import { EventEmitter } from 'events';
import type { Logger } from '../utils/logger';
import type { SessionManager } from './sessionManager';
import { GitDiffManager, type GitDiffResult } from './gitDiffManager';
import type { CreateExecutionDiffData, ExecutionDiff } from '../database/models';

interface ExecutionContext {
  sessionId: string;
  worktreePath: string;
  promptMarkerId?: number;
  beforeCommitHash: string;
  executionSequence: number;
  prompt?: string;
}

export class ExecutionTracker extends EventEmitter {
  private activeExecutions: Map<string, ExecutionContext> = new Map();

  constructor(
    private sessionManager: import('./sessionManager').SessionManager,
    private gitDiffManager: GitDiffManager,
    private logger?: Logger
  ) {
    super();
  }

  /**
   * Start tracking a new prompt execution
   */
  async startExecution(sessionId: string, worktreePath: string, promptMarkerId?: number, prompt?: string): Promise<void> {
    try {
      console.log(`[ExecutionTracker] Starting execution tracking for session ${sessionId}`);
      this.logger?.verbose(`Starting execution tracking for session ${sessionId}`);

      // Get next execution sequence
      const executionSequence = await this.sessionManager.getNextExecutionSequence(sessionId);

      // Capture the current commit hash as the starting point
      const ctx = this.sessionManager.getProjectContext(sessionId);
      if (!ctx) {
        throw new Error(`No project context found for session ${sessionId}`);
      }
      const beforeCommitHash = this.gitDiffManager.getCurrentCommitHash(worktreePath, ctx.commandRunner);
      console.log(`[ExecutionTracker] Starting from commit: ${beforeCommitHash}, sequence: ${executionSequence}`);
      this.logger?.verbose(`Starting from commit: ${beforeCommitHash}`);
      
      const context: ExecutionContext = {
        sessionId,
        worktreePath,
        promptMarkerId,
        beforeCommitHash,
        executionSequence,
        prompt
      };
      
      this.activeExecutions.set(sessionId, context);
      this.emit('execution-started', { sessionId, executionSequence });
      
    } catch (error) {
      this.logger?.error(`Failed to start execution tracking for session ${sessionId}:`, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * End execution tracking and capture final diff
   */
  async endExecution(sessionId: string): Promise<void> {
    try {
      console.log(`[ExecutionTracker] Ending execution tracking for session ${sessionId}`);
      const context = this.activeExecutions.get(sessionId);
      if (!context) {
        console.log(`[ExecutionTracker] No active execution found for session ${sessionId}`);
        this.logger?.warn(`No active execution found for session ${sessionId}`);
        return;
      }

      this.logger?.verbose(`Ending execution tracking for session ${sessionId}`);

      // Get the current commit hash
      const ctx = this.sessionManager.getProjectContext(sessionId);
      if (!ctx) {
        throw new Error(`No project context found for session ${sessionId}`);
      }
      const afterCommitHash = this.gitDiffManager.getCurrentCommitHash(context.worktreePath, ctx.commandRunner);

      let executionDiff: GitDiffResult;

      // Always get the diff between the before and after commits
      if (afterCommitHash === context.beforeCommitHash) {
        executionDiff = await this.gitDiffManager.captureWorkingDirectoryDiff(context.worktreePath, ctx.commandRunner);
        this.logger?.verbose(`No changes made during execution`);
      } else {
        executionDiff = await this.gitDiffManager.captureCommitDiff(
          context.worktreePath,
          context.beforeCommitHash,
          afterCommitHash,
          ctx.commandRunner
        );
        this.logger?.verbose(`Captured diff between commits ${context.beforeCommitHash} and ${afterCommitHash}`);
      }

      // Get the commit message if a commit was made
      let commitMessage = '';
      if (afterCommitHash !== context.beforeCommitHash && afterCommitHash !== 'UNCOMMITTED') {
        try {
          commitMessage = ctx.commandRunner.exec(`git log -1 --format=%s ${afterCommitHash}`, context.worktreePath).trim();
          this.logger?.verbose(`Retrieved commit message: ${commitMessage}`);
        } catch (error) {
          this.logger?.warn(`Failed to get commit message: ${error}`);
        }
      }

      // Always create execution diff record
      const diffData: CreateExecutionDiffData = {
        session_id: sessionId,
        prompt_marker_id: context.promptMarkerId,
        execution_sequence: context.executionSequence,
        git_diff: executionDiff.diff,
        files_changed: executionDiff.changedFiles,
        stats_additions: executionDiff.stats.additions,
        stats_deletions: executionDiff.stats.deletions,
        stats_files_changed: executionDiff.stats.filesChanged,
        before_commit_hash: executionDiff.beforeHash,
        after_commit_hash: executionDiff.afterHash,
        commit_message: commitMessage || undefined
      };

      const createdDiff = await this.sessionManager.createExecutionDiff(diffData);

      console.log(`[ExecutionTracker] Created execution diff for session ${sessionId}:`, {
        id: createdDiff.id,
        execution_sequence: createdDiff.execution_sequence,
        files_changed: createdDiff.stats_files_changed,
        commit_message: createdDiff.commit_message,
        after_commit_hash: createdDiff.after_commit_hash
      });

      if (executionDiff.stats.filesChanged > 0) {
        this.logger?.verbose(`Created execution diff ${createdDiff.id}: ${createdDiff.stats_files_changed} files, +${createdDiff.stats_additions} -${createdDiff.stats_deletions}`);
      } else {
        this.logger?.verbose(`Created execution diff ${createdDiff.id} with no changes for execution ${context.executionSequence} in session ${sessionId}`);
      }

      this.emit('execution-completed', {
        sessionId,
        executionSequence: context.executionSequence,
        diffId: createdDiff.id,
        stats: executionDiff.stats
      });

      this.activeExecutions.delete(sessionId);

    } catch (error) {
      this.logger?.error(`Failed to end execution tracking for session ${sessionId}:`, error instanceof Error ? error : undefined);
      this.activeExecutions.delete(sessionId);
      throw error;
    }
  }

  /**
   * Cancel execution tracking (e.g., if Claude Code process fails)
   */
  cancelExecution(sessionId: string): void {
    const context = this.activeExecutions.get(sessionId);
    if (context) {
      this.logger?.verbose(`Cancelling execution tracking for session ${sessionId}`);
      this.activeExecutions.delete(sessionId);
      this.emit('execution-cancelled', { sessionId, executionSequence: context.executionSequence });
    }
  }

  /**
   * Check if execution is being tracked for a session
   */
  isTracking(sessionId: string): boolean {
    return this.activeExecutions.has(sessionId);
  }

  /**
   * Get execution context for a session
   */
  getExecutionContext(sessionId: string): ExecutionContext | undefined {
    return this.activeExecutions.get(sessionId);
  }

  /**
   * Get combined diff for multiple executions
   */
  async getCombinedDiff(sessionId: string, executionIds?: number[]): Promise<GitDiffResult> {
    const executions = await this.sessionManager.getExecutionDiffs(sessionId);
    
    // Commented out verbose logging
    // console.log(`[ExecutionTracker] getCombinedDiff for session ${sessionId}, found ${executions.length} executions`);
    
    let filteredExecutions = executions;
    if (executionIds && executionIds.length > 0) {
      filteredExecutions = executions.filter((exec: ExecutionDiff) => executionIds.includes(exec.id));
      // console.log(`[ExecutionTracker] Filtered to ${filteredExecutions.length} executions`);
    }
    
    const diffs: GitDiffResult[] = filteredExecutions
      .filter((exec: ExecutionDiff) => exec.git_diff) // Only include executions with actual diffs
      .map((exec: ExecutionDiff) => ({
        diff: exec.git_diff!,
        stats: {
          additions: exec.stats_additions,
          deletions: exec.stats_deletions,
          filesChanged: exec.stats_files_changed
        },
        changedFiles: exec.files_changed || [],
        beforeHash: exec.before_commit_hash,
        afterHash: exec.after_commit_hash
      }));
    
    // console.log(`[ExecutionTracker] Found ${diffs.length} diffs to combine`);
    
    return this.gitDiffManager.combineDiffs(diffs);
  }

  async getExecutionDiffs(sessionId: string): Promise<ExecutionDiff[]> {
    const diffs = await this.sessionManager.getExecutionDiffs(sessionId);
    // Commented out verbose logging
    // console.log(`[ExecutionTracker] getExecutionDiffs returned ${diffs.length} diffs for session ${sessionId}`);
    // if (diffs.length > 0) {
    //   console.log(`[ExecutionTracker] First diff:`, {
    //     id: diffs[0].id,
    //     hasGitDiff: !!diffs[0].git_diff,
    //     gitDiffLength: diffs[0].git_diff?.length || 0,
    //     stats: {
    //       additions: diffs[0].stats_additions,
    //       deletions: diffs[0].stats_deletions,
    //       filesChanged: diffs[0].stats_files_changed
    //     }
    //   });
    // }
    return diffs;
  }
}