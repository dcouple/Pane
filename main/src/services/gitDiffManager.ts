import { createReadStream } from 'fs';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import type { Logger } from '../utils/logger';
import type { AnalyticsManager } from './analyticsManager';
import { CommandRunner } from '../utils/commandRunner';
import { linuxToUNCPath, posixJoin, type WSLContext } from '../utils/wslUtils';
import {
  MAX_FILES_PER_COMMIT,
  WORKING_TREE_REF,
  type GitCommitFileChange,
  type GitCommitFilesResult,
  type GitFileChangeStatus,
} from '../../../shared/types/git';

export interface GitDiffStats {
  additions: number;
  deletions: number;
  filesChanged: number;
}

export interface GitDiffResult {
  diff: string;
  stats: GitDiffStats;
  changedFiles: string[];
  beforeHash?: string;
  afterHash?: string;
}

export interface GitCommit {
  hash: string;
  message: string;
  date: Date;
  author: string;
  stats: GitDiffStats;
}

export interface GitGraphCommit {
  hash: string;
  parents: string[];
  branch: string;
  message: string;
  committerDate: string;
  author: string;
  authorEmail?: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
}

const COMMIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Caps on inlining untracked file content into a synthesized diff.
 *
 * The resulting patch is parsed with a regex in the renderer, so an unignored
 * build directory would otherwise hand it megabytes to chew through.
 */
export const MAX_UNTRACKED_INLINE_FILES = 200;
const MAX_UNTRACKED_INLINE_BYTES = 2 * 1024 * 1024;

/**
 * Per-file ceiling for inlining. Matches the buffer the previous `cat` had, so
 * the same oversized files are left out of the patch as before.
 */
const MAX_UNTRACKED_INLINE_FILE_BYTES = 1024 * 1024;

/** A working-tree diff can be large; don't truncate it at Node's 1MB default. */
const MAX_DIFF_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Split NUL-separated git output.
 *
 * Git only quotes and escapes a path when it has to delimit it with a newline;
 * under `-z` the bytes come through exactly as they are on disk. Nothing is
 * trimmed here for the same reason — a leading or trailing space is part of the
 * name, not padding.
 */
export function splitNulSeparated(raw: string): string[] {
  return raw.split('\0').filter(entry => entry.length > 0);
}

/**
 * The path Node's `fs` needs for a file git named relative to the worktree.
 *
 * Git reports `dir/file.txt` with forward slashes whatever the platform. For a
 * WSL project the worktree is a Linux path the Windows host can only reach
 * through its UNC mount, which is what `gitPlumbingCommands` does for the same
 * reason.
 *
 * Going through `fs` at all is the point: the name comes from the repository
 * and may contain a space, a quote, `$`, a backtick or a newline, all of which
 * git allows. Interpolated into a shell command those stop being a filename.
 */
export function untrackedFilePath(
  worktreePath: string,
  file: string,
  wslContext?: WSLContext | null
): string {
  if (wslContext) return linuxToUNCPath(posixJoin(worktreePath, file), wslContext.distribution);
  return join(worktreePath, file);
}

/**
 * Newlines in a file, streamed so a large one costs bounded memory.
 *
 * Counts terminators rather than lines, which is what the `wc -l` this replaces
 * reported, so the additions figure stays the number it always was.
 */
async function countNewlines(fsPath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let count = 0;
    const stream = createReadStream(fsPath, { highWaterMark: 64 * 1024 });

    stream.on('data', chunk => {
      const buffer = Buffer.from(chunk);
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === 0x0a) count++;
      }
    });
    stream.on('error', reject);
    stream.on('close', () => resolve(count));
  });
}

interface NumstatEntry {
  oldPath: string;
  path: string;
  additions: number | null;
  deletions: number | null;
  isBinary: boolean;
}

/**
 * Parse `--numstat -z` output.
 *
 * With `-z` each record is `<add>\t<del>\t<path>\0`, except renames/copies
 * which emit an empty path field followed by two NUL-separated paths:
 * `<add>\t<del>\t\0<oldPath>\0<newPath>\0`. Binary files report `-` for both
 * counts. Paths are never quoted under `-z`, so a tab or quote inside a
 * filename is safe as long as we only split on the first two tabs.
 */
export function parseNumstatZ(raw: string): NumstatEntry[] {
  const tokens = raw.split('\0');
  const entries: NumstatEntry[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    i++;
    if (!token) continue;

    const firstTab = token.indexOf('\t');
    if (firstTab < 0) continue;
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (secondTab < 0) continue;

    const addRaw = token.slice(0, firstTab);
    const delRaw = token.slice(firstTab + 1, secondTab);
    const pathField = token.slice(secondTab + 1);

    let oldPath: string;
    let path: string;
    if (pathField === '') {
      // Rename/copy: the two paths follow as separate NUL-delimited tokens.
      oldPath = tokens[i] ?? '';
      i++;
      path = tokens[i] ?? '';
      i++;
      if (!path) path = oldPath;
    } else {
      oldPath = pathField;
      path = pathField;
    }

    const isBinary = addRaw === '-' || delRaw === '-';
    entries.push({
      oldPath,
      path,
      additions: isBinary ? null : Number.parseInt(addRaw, 10) || 0,
      deletions: isBinary ? null : Number.parseInt(delRaw, 10) || 0,
      isBinary,
    });
  }

  return entries;
}

function toFileChangeStatus(code: string): GitFileChangeStatus {
  switch (code) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'typechange';
    case 'U': return 'unmerged';
    default: return 'unknown';
  }
}

interface NameStatusEntry {
  oldPath: string;
  path: string;
  status: GitFileChangeStatus;
}

/**
 * Parse `--name-status -z` output: `M\0path\0`, `A\0path\0`,
 * `R100\0oldPath\0newPath\0`. Only `R` and `C` carry two paths.
 */
export function parseNameStatusZ(raw: string): NameStatusEntry[] {
  const tokens = raw.split('\0');
  const entries: NameStatusEntry[] = [];
  let i = 0;

  while (i < tokens.length) {
    const statusToken = tokens[i];
    i++;
    if (!statusToken) continue;

    const code = statusToken[0];
    const status = toFileChangeStatus(code);
    if (code === 'R' || code === 'C') {
      const oldPath = tokens[i] ?? '';
      i++;
      const path = tokens[i] ?? '';
      i++;
      if (!oldPath && !path) continue;
      entries.push({
        oldPath,
        path: path || oldPath,
        status,
      });
    } else {
      const path = tokens[i] ?? '';
      i++;
      if (!path) continue;
      entries.push({ oldPath: path, path, status });
    }
  }

  return entries;
}

/**
 * Zip numstat counts with name-status change kinds, keyed by post-change path.
 * numstat is the source of truth for the file set; a path missing from
 * name-status falls back to `modified`.
 */
export function mergeFileChanges(
  numstat: NumstatEntry[],
  nameStatus: NameStatusEntry[]
): GitCommitFileChange[] {
  const statusByPath = new Map(nameStatus.map(entry => [entry.path, entry]));

  return numstat.map(entry => {
    const match = statusByPath.get(entry.path);
    const fileChange: GitCommitFileChange = {
      path: entry.path,
      oldPath: match?.oldPath || entry.oldPath || entry.path,
      status: match?.status ?? 'modified',
      additions: entry.additions,
      deletions: entry.deletions,
      isBinary: entry.isBinary,
    };
    return fileChange;
  });
}

/**
 * Parse untracked paths out of `git status --porcelain -z`.
 *
 * Porcelain v1 with `-z` emits `XY <path>\0`; rename entries emit a second
 * path token which we skip. Only `??` records are returned.
 */
export function parseUntrackedPathsZ(raw: string): string[] {
  const tokens = raw.split('\0');
  const paths: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    i++;
    if (!token || token.length < 4) continue;

    const code = token.slice(0, 2);
    const path = token.slice(3);
    // Rename/copy records carry the original path as an extra token.
    if (code[0] === 'R' || code[0] === 'C') i++;
    if (code === '??') paths.push(path);
  }

  return paths;
}

export class GitDiffManager {
  constructor(
    private logger?: Logger,
    private analyticsManager?: AnalyticsManager
  ) {}

  /**
   * Capture git diff for a worktree directory
   */
  async captureWorkingDirectoryDiff(worktreePath: string, commandRunner: CommandRunner): Promise<GitDiffResult> {
    try {
      console.log(`captureWorkingDirectoryDiff called for: ${worktreePath}`);
      this.logger?.verbose(`Capturing git diff in ${worktreePath}`);

      // Get current commit hash
      const beforeHash = this.getCurrentCommitHash(worktreePath, commandRunner);

      // Listed once and threaded through: each `git ls-files` is a process
      // spawn, and the three consumers below used to ask for it separately.
      const untrackedFiles = await this.getUntrackedFilesAsync(worktreePath, commandRunner);

      // Get diff of working directory vs HEAD
      const diff = await this.getGitDiffStringAsync(worktreePath, untrackedFiles, commandRunner);
      console.log(`Captured diff length: ${diff.length}`);

      // Get changed files
      const changedFiles = await this.getChangedFilesAsync(worktreePath, untrackedFiles, commandRunner);

      // Get diff stats
      const stats = await this.getDiffStatsAsync(worktreePath, untrackedFiles, commandRunner);

      this.logger?.verbose(`Captured diff: ${stats.filesChanged} files, +${stats.additions} -${stats.deletions}`);
      console.log(`Diff stats:`, stats);

      return {
        diff,
        stats,
        changedFiles,
        beforeHash,
        afterHash: undefined // No after hash for working directory changes
      };
    } catch (error) {
      this.logger?.error(`Failed to capture git diff in ${worktreePath}:`, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Capture git diff between two commits or between commit and working directory
   */
  async captureCommitDiff(worktreePath: string, fromCommit: string, toCommit: string | undefined, commandRunner: CommandRunner): Promise<GitDiffResult> {
    try {
      const to = toCommit || 'HEAD';
      this.logger?.verbose(`Capturing git diff in ${worktreePath} from ${fromCommit} to ${to}`);

      // Get diff between commits
      const diff = this.getGitCommitDiff(worktreePath, fromCommit, to, commandRunner);

      // Get changed files between commits
      const changedFiles = this.getChangedFilesBetweenCommits(worktreePath, fromCommit, to, commandRunner);

      // Get diff stats between commits
      const stats = this.getCommitDiffStats(worktreePath, fromCommit, to, commandRunner);

      return {
        diff,
        stats,
        changedFiles,
        beforeHash: fromCommit,
        afterHash: to === 'HEAD' ? this.getCurrentCommitHash(worktreePath, commandRunner) : to
      };
    } catch (error) {
      this.logger?.error(`Failed to capture commit diff in ${worktreePath}:`, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Get git commit history for a worktree (only commits unique to this branch)
   */
  getCommitHistory(worktreePath: string, limit: number, comparisonBranch: string, commandRunner: CommandRunner): GitCommit[] {
    try {
      // Get commit log with stats for commits in HEAD not in the comparison branch.
      // Two-dot range: commits reachable from HEAD but not from comparisonBranch.
      const logFormat = '%H|%s|%ai|%an';
      const gitCommand = `git log --format="${logFormat}" --numstat -n ${limit} ${comparisonBranch}..HEAD --`;

      console.log(`[GitDiffManager] Getting commit history for worktree: ${worktreePath}`);
      console.log(`[GitDiffManager] Comparison branch: ${comparisonBranch}`);
      console.log(`[GitDiffManager] Git command: ${gitCommand}`);

      const logOutput = commandRunner.exec(gitCommand, worktreePath);
      console.log(`[GitDiffManager] Git log output length: ${logOutput.length} characters`);

      const commits: GitCommit[] = [];
      const lines = logOutput.trim().split('\n');
      console.log(`[GitDiffManager] Total lines to parse: ${lines.length}`);
      
      let currentCommit: GitCommit | null = null;
      let statsLines: string[] = [];

      for (const line of lines) {
        if (line.includes('|')) {
          // Process previous commit's stats if any
          if (currentCommit && statsLines.length > 0) {
            const stats = this.parseNumstatOutput(statsLines);
            currentCommit.stats = stats;
          }

          // Start new commit
          const [hash, message, date, author] = line.split('|');
          
          // Validate and parse the date
          let parsedDate: Date;
          try {
            parsedDate = new Date(date);
            // Check if the date is valid
            if (isNaN(parsedDate.getTime())) {
              throw new Error('Invalid date');
            }
          } catch {
            // Fall back to current date if parsing fails
            parsedDate = new Date();
            this.logger?.warn(`Invalid date format in git log: "${date}". Using current date as fallback.`);
          }
          
          currentCommit = {
            hash,
            message,
            date: parsedDate,
            author,
            stats: { additions: 0, deletions: 0, filesChanged: 0 }
          };
          commits.push(currentCommit);
          statsLines = [];
        } else if (line.trim() && currentCommit) {
          // Collect stat lines
          statsLines.push(line);
        }
      }

      // Process last commit's stats
      if (currentCommit && statsLines.length > 0) {
        const stats = this.parseNumstatOutput(statsLines);
        currentCommit.stats = stats;
      }

      console.log(`[GitDiffManager] Found ${commits.length} commits unique to this branch`);
      if (commits.length === 0) {
        console.log(`[GitDiffManager] No unique commits found. This could mean:`);
        console.log(`[GitDiffManager]   - The branch is up-to-date with ${comparisonBranch}`);
        console.log(`[GitDiffManager]   - The branch has been rebased onto ${comparisonBranch}`);
        console.log(`[GitDiffManager]   - The ${comparisonBranch} branch doesn't exist in this worktree`);
      }

      return commits;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger?.error('Failed to get commit history', error instanceof Error ? error : undefined);
      console.error(`[GitDiffManager] Error getting commit history: ${errorMessage}`);
      console.error(`[GitDiffManager] Full error:`, error);
      
      // If it's a git command error, throw it so the caller can handle it appropriately
      if (errorMessage.includes('fatal:') || errorMessage.includes('error:')) {
        console.error(`[GitDiffManager] Git command failed. This might happen if the ${comparisonBranch} branch doesn't exist.`);
        throw new Error(`Git error: ${errorMessage}`);
      }
      
      // For other errors, return empty array as fallback
      return [];
    }
  }

  /**
   * Get git commit history for the graph visualization (lightweight, no stats)
   */
  getGraphCommitHistory(
    worktreePath: string,
    branch: string,
    limit: number = 50,
    comparisonBranch: string = 'main',
    commandRunner: CommandRunner
  ): GitGraphCommit[] {
    try {
      // Use %x00 (NUL) as field delimiter since commit messages can contain pipes
      // Use %x01 as record delimiter to separate commits (--shortstat adds extra lines)
      const logFormat = '%x01%h%x00%p%x00%s%x00%ai%x00%an%x00%ae';
      const gitCommand = `git log --format="${logFormat}" --shortstat -n ${limit} ${comparisonBranch}..HEAD --`;

      const logOutput = commandRunner.exec(gitCommand, worktreePath);

      if (!logOutput.trim()) {
        return [];
      }

      // Split by record delimiter, each record has the commit line + optional shortstat line
      return logOutput.split('\x01').filter(Boolean).map(record => {
        const lines = record.trim().split('\n').filter(Boolean);
        const [hash, parentStr, message, date, author, email] = lines[0].split('\x00');

        const commit: GitGraphCommit = {
          hash,
          parents: parentStr ? parentStr.split(' ').filter(Boolean) : [],
          branch,
          message,
          committerDate: date,
          author,
          authorEmail: email
        };

        // Parse shortstat line if present (e.g. " 3 files changed, 10 insertions(+), 2 deletions(-)")
        if (lines.length > 1) {
          const statsMatch = lines[lines.length - 1].match(
            /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
          );
          if (statsMatch) {
            commit.filesChanged = parseInt(statsMatch[1]) || 0;
            commit.additions = parseInt(statsMatch[2]) || 0;
            commit.deletions = parseInt(statsMatch[3]) || 0;
          }
        }

        return commit;
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger?.error('Failed to get graph commit history', error instanceof Error ? error : undefined);

      if (errorMessage.includes('fatal:') || errorMessage.includes('error:')) {
        throw new Error(`Git error: ${errorMessage}`);
      }

      return [];
    }
  }

  /**
   * List the files touched by a single commit — or by the working tree when
   * `ref` is {@link WORKING_TREE_REF} — with per-file +/- counts and change kind.
   *
   * Deliberately patch-free: the diff panel calls this lazily when one commit
   * row is expanded, so listing 50 commits never costs 50 `git show`s.
   */
  getCommitFileChanges(
    worktreePath: string,
    ref: string,
    commandRunner: CommandRunner
  ): GitCommitFilesResult {
    const empty: GitCommitFilesResult = {
      ref,
      files: [],
      totalFiles: 0,
      truncated: false,
      isMergeAgainstFirstParent: false,
    };

    try {
      if (ref === WORKING_TREE_REF || ref === 'UNCOMMITTED') {
        return this.getWorkingTreeFileChanges(worktreePath, commandRunner);
      }
      if (!COMMIT_OBJECT_ID_PATTERN.test(ref)) {
        this.logger?.warn(`Rejected invalid commit object ID: ${ref}`);
        return empty;
      }

      // `git show` prints nothing for a merge commit unless we ask for a
      // specific parent. Detect the merge first so the UI can say so.
      const parents = this.getCommitParents(worktreePath, ref, commandRunner);
      const isMerge = parents.length > 1;
      const mergeFlags = isMerge ? ' -m --first-parent' : '';

      const numstatRaw = commandRunner.exec(
        `git show --format= --numstat -M -z${mergeFlags} ${ref}`,
        worktreePath
      );
      const nameStatusRaw = commandRunner.exec(
        `git show --format= --name-status -M -z${mergeFlags} ${ref}`,
        worktreePath
      );

      const files = mergeFileChanges(parseNumstatZ(numstatRaw), parseNameStatusZ(nameStatusRaw));
      return this.clampFileChanges(ref, files, isMerge);
    } catch (error) {
      this.logger?.error(
        `Failed to list changed files for ${ref} in ${worktreePath}`,
        error instanceof Error ? error : undefined
      );
      return empty;
    }
  }

  private getWorkingTreeFileChanges(
    worktreePath: string,
    commandRunner: CommandRunner
  ): GitCommitFilesResult {
    const numstatRaw = commandRunner.exec('git diff --numstat -M -z HEAD', worktreePath);
    const nameStatusRaw = commandRunner.exec('git diff --name-status -M -z HEAD', worktreePath);
    const files = mergeFileChanges(parseNumstatZ(numstatRaw), parseNameStatusZ(nameStatusRaw));

    // Untracked files are invisible to `git diff`. Counting their lines would
    // mean reading every file, so they are listed without counts instead.
    try {
      const statusRaw = commandRunner.exec('git status --porcelain -z', worktreePath);
      const known = new Set(files.map(file => file.path));
      for (const path of parseUntrackedPathsZ(statusRaw)) {
        if (known.has(path)) continue;
        files.push({
          path,
          oldPath: path,
          status: 'added',
          additions: null,
          deletions: null,
          isBinary: false,
        });
      }
    } catch {
      // An unreadable status is not worth failing the whole listing over.
    }

    return this.clampFileChanges(WORKING_TREE_REF, files, false);
  }

  private getCommitParents(worktreePath: string, ref: string, commandRunner: CommandRunner): string[] {
    try {
      const output = commandRunner.exec(`git rev-list --parents -n 1 ${ref} --`, worktreePath);
      // Output is "<commit> <parent1> <parent2> ...".
      return output.trim().split(/\s+/).filter(Boolean).slice(1);
    } catch {
      return [];
    }
  }

  private clampFileChanges(
    ref: string,
    files: GitCommitFileChange[],
    isMergeAgainstFirstParent: boolean
  ): GitCommitFilesResult {
    const truncated = files.length > MAX_FILES_PER_COMMIT;
    return {
      ref,
      files: truncated ? files.slice(0, MAX_FILES_PER_COMMIT) : files,
      totalFiles: files.length,
      truncated,
      isMergeAgainstFirstParent,
    };
  }

  /**
   * Parse numstat output to get diff statistics
   */
  private parseNumstatOutput(lines: string[]): GitDiffStats {
    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3) {
        const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
        const deleted = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
        
        if (!isNaN(added) && !isNaN(deleted)) {
          additions += added;
          deletions += deleted;
          filesChanged++;
        }
      }
    }

    return { additions, deletions, filesChanged };
  }

  /**
   * Get diff for a specific commit
   */
  getCommitDiff(worktreePath: string, commitHash: string, commandRunner: CommandRunner): GitDiffResult {
    try {
      const diff = commandRunner.exec(`git show --format= ${commitHash}`, worktreePath);

      const stats = this.getCommitStats(worktreePath, commitHash, commandRunner);
      const changedFiles = this.getCommitChangedFiles(worktreePath, commitHash, commandRunner);

      return {
        diff,
        stats,
        changedFiles,
        beforeHash: `${commitHash}~1`,
        afterHash: commitHash
      };
    } catch (error) {
      this.logger?.error(`Failed to get commit diff for ${commitHash}`, error instanceof Error ? error : undefined);
      return {
        diff: '',
        stats: { additions: 0, deletions: 0, filesChanged: 0 },
        changedFiles: []
      };
    }
  }

  /**
   * Get stats for a specific commit
   */
  private getCommitStats(worktreePath: string, commitHash: string, commandRunner: CommandRunner): GitDiffStats {
    try {
      const fullOutput = commandRunner.exec(`git show --stat --format= ${commitHash}`, worktreePath);
      // Get the last line manually instead of using tail
      const lines = fullOutput.trim().split('\n');
      const statsOutput = lines[lines.length - 1];
      return this.parseDiffStats(statsOutput);
    } catch {
      return { additions: 0, deletions: 0, filesChanged: 0 };
    }
  }

  /**
   * Get changed files for a specific commit
   */
  private getCommitChangedFiles(worktreePath: string, commitHash: string, commandRunner: CommandRunner): string[] {
    try {
      const output = commandRunner.exec(`git show --name-only --format= ${commitHash}`, worktreePath);
      return output.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Combine multiple diffs into a single diff
   */
  combineDiffs(diffs: GitDiffResult[]): GitDiffResult {
    const combinedDiff = diffs.map(d => d.diff).join('\n\n');
    
    // Aggregate stats
    const stats: GitDiffStats = {
      additions: diffs.reduce((sum, d) => sum + d.stats.additions, 0),
      deletions: diffs.reduce((sum, d) => sum + d.stats.deletions, 0),
      filesChanged: 0 // Will be calculated from unique files
    };
    
    // Get unique changed files
    const allFiles = new Set<string>();
    diffs.forEach(d => d.changedFiles.forEach(f => allFiles.add(f)));
    const changedFiles = Array.from(allFiles);
    stats.filesChanged = changedFiles.length;
    
    return {
      diff: combinedDiff,
      stats,
      changedFiles,
      beforeHash: diffs[0]?.beforeHash,
      afterHash: diffs[diffs.length - 1]?.afterHash
    };
  }

  getCurrentCommitHash(worktreePath: string, commandRunner: CommandRunner): string {
    try {
      return commandRunner.exec('git rev-parse HEAD', worktreePath).trim();
    } catch {
      this.logger?.warn(`Could not get current commit hash in ${worktreePath}`);
      return '';
    }
  }

  async getGitDiff(worktreePath: string, commandRunner: CommandRunner): Promise<GitDiffResult> {
    const result = await this.captureWorkingDirectoryDiff(worktreePath, commandRunner);

    // Track git diff viewed
    if (this.analyticsManager) {
      const fileCountCategory = this.analyticsManager.categorizeNumber(result.stats.filesChanged, [1, 5, 10, 25, 50]);
      const hasUncommitted = this.hasChanges(worktreePath, commandRunner);

      this.analyticsManager.track('git_diff_viewed', {
        file_count_category: fileCountCategory,
        has_uncommitted: hasUncommitted
      });
    }

    return result;
  }


  private getGitCommitDiff(worktreePath: string, fromCommit: string, toCommit: string, commandRunner: CommandRunner): string {
    try {
      return commandRunner.exec(`git diff ${fromCommit}..${toCommit}`, worktreePath);
    } catch {
      this.logger?.warn(`Could not get git commit diff in ${worktreePath}`);
      return '';
    }
  }

  private getChangedFilesBetweenCommits(worktreePath: string, fromCommit: string, toCommit: string, commandRunner: CommandRunner): string[] {
    try {
      const output = commandRunner.exec(`git diff --name-only ${fromCommit}..${toCommit}`, worktreePath);
      return output.trim().split('\n').filter((f: string) => f.length > 0);
    } catch {
      this.logger?.warn(`Could not get changed files between commits in ${worktreePath}`);
      return [];
    }
  }

  // --- Working-directory capture (async) -----------------------------------
  //
  // Everything below runs off the main thread. The sync variants used to spawn
  // one child process *per untracked file* — twice, once to read content and
  // once to count lines — which on a worktree carrying an unignored build tree
  // blocked the main process for minutes and froze every IPC channel with it.
  // These versions list the files once with `git ls-files -z` and then go
  // through `fs`, so there is no process per file and no filename in a shell.

  /**
   * Untracked paths, honouring .gitignore.
   *
   * `-z` is not optional here. Without it git delimits with newlines, which a
   * filename may contain, and quotes anything non-ASCII into a C-style escape:
   * `täst.txt` arrives as `"t\303\244st.txt"`, a name that matches no file on
   * disk, so the file silently vanished from the diff and the stats.
   */
  private async getUntrackedFilesAsync(worktreePath: string, commandRunner: CommandRunner): Promise<string[]> {
    try {
      const { stdout } = await commandRunner.execAsync('git ls-files --others --exclude-standard -z', worktreePath);
      return splitNulSeparated(stdout ?? '');
    } catch {
      this.logger?.warn(`Could not get untracked files in ${worktreePath}`);
      return [];
    }
  }

  private async getGitDiffStringAsync(
    worktreePath: string,
    untrackedFiles: string[],
    commandRunner: CommandRunner
  ): Promise<string> {
    let diff = '';
    try {
      const { stdout } = await commandRunner.execAsync('git diff HEAD', worktreePath, { maxBuffer: MAX_DIFF_BUFFER_BYTES });
      diff = stdout ?? '';
    } catch (error) {
      this.logger?.warn(`Could not get tracked diff in ${worktreePath}: ${error instanceof Error ? error.message : error}`);
    }

    if (untrackedFiles.length === 0) return diff;
    return diff + await this.createDiffForUntrackedFilesAsync(worktreePath, untrackedFiles, commandRunner);
  }

  private async getChangedFilesAsync(
    worktreePath: string,
    untrackedFiles: string[],
    commandRunner: CommandRunner
  ): Promise<string[]> {
    try {
      const { stdout } = await commandRunner.execAsync('git diff --name-only -z HEAD', worktreePath);
      const tracked = splitNulSeparated(stdout ?? '');
      return [...tracked, ...untrackedFiles];
    } catch {
      this.logger?.warn(`Could not get changed files in ${worktreePath}`);
      return [...untrackedFiles];
    }
  }

  /**
   * Working-tree stats. Untracked line counts are read through `fs` rather than
   * by spawning a process per file — the difference between a few reads and
   * several thousand child processes.
   */
  private async getDiffStatsAsync(
    worktreePath: string,
    untrackedFiles: string[],
    commandRunner: CommandRunner
  ): Promise<GitDiffStats> {
    let trackedStats: GitDiffStats = { additions: 0, deletions: 0, filesChanged: 0 };
    try {
      const { stdout } = await commandRunner.execAsync('git diff --shortstat HEAD', worktreePath);
      trackedStats = this.parseDiffStats((stdout ?? '').trim());
    } catch {
      this.logger?.warn(`Could not get diff stats in ${worktreePath}`);
    }

    if (untrackedFiles.length === 0) return trackedStats;

    const untrackedAdditions = await this.countUntrackedLines(worktreePath, untrackedFiles, commandRunner);
    return {
      additions: trackedStats.additions + untrackedAdditions,
      deletions: trackedStats.deletions,
      filesChanged: trackedStats.filesChanged + untrackedFiles.length,
    };
  }

  /**
   * Total line count across the untracked files.
   *
   * Each file is streamed, so memory stays bounded whatever is in the worktree
   * and nothing repository-controlled reaches a shell. Awaiting between files
   * keeps the event loop free, which is what the synchronous version cost.
   */
  private async countUntrackedLines(
    worktreePath: string,
    files: string[],
    commandRunner: CommandRunner
  ): Promise<number> {
    let total = 0;
    for (const file of files) {
      try {
        total += await countNewlines(untrackedFilePath(worktreePath, file, commandRunner.wslContext));
      } catch {
        // Unreadable (permissions, a symlink to nowhere, deleted since the
        // listing): its lines simply go uncounted, as before.
      }
    }
    return total;
  }

  /**
   * Synthesize `new file` patches for untracked files.
   *
   * Content is read through `fs`, never `cat`: a filename may legally contain
   * a backtick or `$(…)`, and interpolating one into a shell command ran it.
   *
   * Still hard-bounded — the resulting patch is parsed with a regex in the
   * renderer, so an unignored build tree would otherwise stall it. Files past
   * the budget keep their place in `changedFiles`; only the inline content goes.
   */
  private async createDiffForUntrackedFilesAsync(
    worktreePath: string,
    untrackedFiles: string[],
    commandRunner: CommandRunner
  ): Promise<string> {
    const parts: string[] = [];
    let bytes = 0;
    let inlined = 0;

    for (const file of untrackedFiles) {
      if (inlined >= MAX_UNTRACKED_INLINE_FILES || bytes >= MAX_UNTRACKED_INLINE_BYTES) {
        this.logger?.warn(
          `Untracked diff truncated in ${worktreePath}: ${untrackedFiles.length} untracked files exceed the inline budget`
        );
        break;
      }

      try {
        const fsPath = untrackedFilePath(worktreePath, file, commandRunner.wslContext);

        // Checked before reading rather than by letting a buffer overflow, so a
        // huge file costs a stat instead of a gigabyte of string.
        const { size } = await stat(fsPath);
        if (size > MAX_UNTRACKED_INLINE_FILE_BYTES) continue;

        const content = await readFile(fsPath, 'utf8');
        inlined++;

        const lines = content.split('\n');
        const header =
          `diff --git a/${file} b/${file}\n`
          + 'new file mode 100644\n'
          + 'index 0000000..0000000\n'
          + '--- /dev/null\n'
          + `+++ b/${file}\n`
          + `@@ -0,0 +1,${lines.length} @@\n`;
        const body = lines.map(line => `+${line}`).join('\n') + '\n';

        parts.push(header, body);
        bytes += header.length + body.length;
      } catch {
        // Binary or unreadable files are omitted from the synthesized patch.
      }
    }

    return parts.join('');
  }

  private getCommitDiffStats(worktreePath: string, fromCommit: string, toCommit: string, commandRunner: CommandRunner): GitDiffStats {
    try {
      const output = commandRunner.exec(`git diff --stat ${fromCommit}..${toCommit}`, worktreePath);
      
      return this.parseDiffStats(output);
    } catch {
      this.logger?.warn(`Could not get commit diff stats in ${worktreePath}`);
      return { additions: 0, deletions: 0, filesChanged: 0 };
    }
  }

  parseDiffStats(statsOutput: string): GitDiffStats {
    const lines = statsOutput.trim().split('\n');
    const summaryLine = lines[lines.length - 1];
    
    // Parse summary line like: "3 files changed, 45 insertions(+), 12 deletions(-)"
    const fileMatch = summaryLine.match(/(\d+) files? changed/);
    const addMatch = summaryLine.match(/(\d+) insertions?\(\+\)/);
    const delMatch = summaryLine.match(/(\d+) deletions?\(-\)/);
    
    return {
      filesChanged: fileMatch ? parseInt(fileMatch[1]) : 0,
      additions: addMatch ? parseInt(addMatch[1]) : 0,
      deletions: delMatch ? parseInt(delMatch[1]) : 0
    };
  }

  /**
   * Check if there are any changes in the working directory
   */
  hasChanges(worktreePath: string, commandRunner: CommandRunner): boolean {
    try {
      const output = commandRunner.exec('git status --porcelain', worktreePath);
      return output.trim().length > 0;
    } catch {
      this.logger?.warn(`Could not check git status in ${worktreePath}`);
      return false;
    }
  }

}
