import type { Logger } from '../utils/logger';
import type { AnalyticsManager } from './analyticsManager';
import { CommandRunner } from '../utils/commandRunner';

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

      // Get diff of working directory vs HEAD
      const diff = this.getGitDiffString(worktreePath, commandRunner);
      console.log(`Captured diff length: ${diff.length}`);

      // Get changed files
      const changedFiles = this.getChangedFiles(worktreePath, commandRunner);

      // Get diff stats
      const stats = this.getDiffStats(worktreePath, commandRunner);

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
    } catch (error) {
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

  private getGitDiffString(worktreePath: string, commandRunner: CommandRunner): string {
    try {
      // First check if we're in a valid git repository
      try {
        commandRunner.exec('git rev-parse --git-dir', worktreePath);
      } catch {
        console.error(`Not a git repository: ${worktreePath}`);
        return '';
      }

      // Check git status to see what files have changes
      const status = commandRunner.exec('git status --porcelain', worktreePath);
      console.log(`Git status in ${worktreePath}:`, status || '(no changes)');

      // Get diff of both staged and unstaged changes against HEAD
      // Using 'git diff HEAD' to include both staged and unstaged changes
      let diff = commandRunner.exec('git diff HEAD', worktreePath);
      console.log(`Git diff in ${worktreePath}: ${diff.length} characters`);

      // Get untracked files and create diff-like output for them
      const untrackedFiles = this.getUntrackedFiles(worktreePath, commandRunner);
      if (untrackedFiles.length > 0) {
        console.log(`Found ${untrackedFiles.length} untracked files`);
        const untrackedDiff = this.createDiffForUntrackedFiles(worktreePath, untrackedFiles, commandRunner);
        if (untrackedDiff) {
          diff = diff ? diff + '\n' + untrackedDiff : untrackedDiff;
        }
      }
      
      return diff;
    } catch (error) {
      this.logger?.warn(`Could not get git diff in ${worktreePath}`, error instanceof Error ? error : undefined);
      console.error(`Error getting git diff:`, error);
      return '';
    }
  }

  private getGitCommitDiff(worktreePath: string, fromCommit: string, toCommit: string, commandRunner: CommandRunner): string {
    try {
      return commandRunner.exec(`git diff ${fromCommit}..${toCommit}`, worktreePath);
    } catch (error) {
      this.logger?.warn(`Could not get git commit diff in ${worktreePath}`);
      return '';
    }
  }

  private getChangedFiles(worktreePath: string, commandRunner: CommandRunner): string[] {
    try {
      // Get tracked changed files
      const trackedOutput = commandRunner.exec('git diff --name-only HEAD', worktreePath);
      const trackedFiles = trackedOutput.trim().split('\n').filter((f: string) => f.length > 0);

      // Get untracked files
      const untrackedFiles = this.getUntrackedFiles(worktreePath, commandRunner);
      
      // Combine both lists
      return [...trackedFiles, ...untrackedFiles];
    } catch (error) {
      this.logger?.warn(`Could not get changed files in ${worktreePath}`);
      return [];
    }
  }

  private getChangedFilesBetweenCommits(worktreePath: string, fromCommit: string, toCommit: string, commandRunner: CommandRunner): string[] {
    try {
      const output = commandRunner.exec(`git diff --name-only ${fromCommit}..${toCommit}`, worktreePath);
      return output.trim().split('\n').filter((f: string) => f.length > 0);
    } catch (error) {
      this.logger?.warn(`Could not get changed files between commits in ${worktreePath}`);
      return [];
    }
  }

  private getDiffStats(worktreePath: string, commandRunner: CommandRunner): GitDiffStats {
    try {
      const output = commandRunner.exec('git diff --stat HEAD', worktreePath);

      const trackedStats = this.parseDiffStats(output);

      // Add stats for untracked files
      const untrackedFiles = this.getUntrackedFiles(worktreePath, commandRunner);
      if (untrackedFiles.length > 0) {
        let untrackedAdditions = 0;
        for (const file of untrackedFiles) {
          // Skip invalid filenames
          if (!file || file.trim().length === 0) {
            continue;
          }

          try {
            const cleanFile = file.trim();
            const filePath = `${worktreePath}/${cleanFile}`;
            const lines = commandRunner.exec(`wc -l < "${filePath}"`, worktreePath);
            untrackedAdditions += parseInt(lines.trim()) || 0;
          } catch {
            // Skip files that can't be counted
          }
        }
        
        return {
          additions: trackedStats.additions + untrackedAdditions,
          deletions: trackedStats.deletions,
          filesChanged: trackedStats.filesChanged + untrackedFiles.length
        };
      }
      
      return trackedStats;
    } catch (error) {
      this.logger?.warn(`Could not get diff stats in ${worktreePath}`);
      return { additions: 0, deletions: 0, filesChanged: 0 };
    }
  }

  private getCommitDiffStats(worktreePath: string, fromCommit: string, toCommit: string, commandRunner: CommandRunner): GitDiffStats {
    try {
      const output = commandRunner.exec(`git diff --stat ${fromCommit}..${toCommit}`, worktreePath);
      
      return this.parseDiffStats(output);
    } catch (error) {
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
    } catch (error) {
      this.logger?.warn(`Could not check git status in ${worktreePath}`);
      return false;
    }
  }

  /**
   * Get list of untracked files
   */
  private getUntrackedFiles(worktreePath: string, commandRunner: CommandRunner): string[] {
    try {
      const output = commandRunner.exec('git ls-files --others --exclude-standard', worktreePath);
      
      // Handle empty output case
      if (!output || output.trim().length === 0) {
        return [];
      }
      
      return output.trim().split('\n').filter((f: string) => f && f.trim().length > 0);
    } catch (error) {
      this.logger?.warn(`Could not get untracked files in ${worktreePath}`);
      return [];
    }
  }

  /**
   * Create diff-like output for untracked files
   */
  private createDiffForUntrackedFiles(worktreePath: string, untrackedFiles: string[], commandRunner: CommandRunner): string {
    let diffOutput = '';
    
    for (const file of untrackedFiles) {
      // Skip invalid filenames
      if (!file || file.trim().length === 0) {
        continue;
      }
      
      try {
        const cleanFile = file.trim();
        const filePath = `${worktreePath}/${cleanFile}`;
        const fileContent = commandRunner.exec(`cat "${filePath}"`, worktreePath, { maxBuffer: 1024 * 1024 });
        
        // Create a diff-like format for the new file
        diffOutput += `diff --git a/${cleanFile} b/${cleanFile}\n`;
        diffOutput += `new file mode 100644\n`;
        diffOutput += `index 0000000..0000000\n`;
        diffOutput += `--- /dev/null\n`;
        diffOutput += `+++ b/${cleanFile}\n`;
        
        // Add the file content with '+' prefix for each line
        const lines = fileContent.split('\n');
        if (lines.length > 0) {
          diffOutput += `@@ -0,0 +1,${lines.length} @@\n`;
          for (const line of lines) {
            diffOutput += `+${line}\n`;
          }
        }
      } catch (error) {
        // Skip files that can't be read (binary files, etc.)
        const cleanFile = file.trim();
        this.logger?.verbose(`Could not read untracked file ${cleanFile}: ${error}`);
      }
    }
    
    return diffOutput;
  }
}