import { EventEmitter } from 'events';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import path from 'path';
import type { Stats } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { execSync } from '../utils/commandExecutor';
import type { CommandRunner } from '../utils/commandRunner';
import type { PathResolver } from '../utils/pathResolver';
import type { Logger } from '../utils/logger';

// Directories that are effectively never tracked in git and are
// expensive to watch (node_modules alone can be tens of thousands of
// subdirectories). Dirs that are SOMETIMES tracked (dist, build,
// target, coverage) are intentionally excluded from this list so that
// repos that commit build output still get accurate status refreshes.
const IGNORED_DIRS = new Set<string>([
  'node_modules',
  '.git', // narrow .git watcher is separate
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.venv',
  'venv',
  '__pycache__',
  '.svelte-kit',
]);

const IGNORED_FILE_PATTERNS: RegExp[] = [
  /^\.DS_Store$/,
  /^thumbs\.db$/i,
  /\.swp$/,
  /\.swo$/,
  /~$/,
  /^\.#/,
  /^#.+#$/,
];

interface WatchedSession {
  sessionId: string;
  worktreePath: string;
  worktreeWatcher?: FSWatcher;
  gitWatcher?: FSWatcher;
  wslWatcher?: ChildProcess;
  lastModified: number;
  pendingRefresh: boolean;
}

/**
 * Smart file watcher that detects when git status actually needs refreshing
 *
 * Key optimizations:
 * 1. Uses chokidar with function-form ignored for efficient file monitoring
 * 2. Short-circuits descent into heavy directories (node_modules, dist, etc.)
 * 3. Batches rapid file changes
 * 4. Uses git update-index to quickly check if index is dirty
 */
export class GitFileWatcher extends EventEmitter {
  private watchedSessions: Map<string, WatchedSession> = new Map();
  private refreshDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEBOUNCE_MS = 1500; // 1.5 second debounce for file changes

  constructor(
    private logger?: Logger,
    private commandRunner?: CommandRunner,
    private pathResolver?: PathResolver
  ) {
    super();
    this.setMaxListeners(100);
  }

  setExecutionContext(commandRunner?: CommandRunner, pathResolver?: PathResolver): void {
    this.commandRunner = commandRunner;
    this.pathResolver = pathResolver;
  }

  /**
   * Start watching a session's worktree for changes
   */
  startWatching(sessionId: string, worktreePath: string): void {
    // Stop existing watcher if any
    this.stopWatching(sessionId);

    try {
      if (this.commandRunner?.wslContext) {
        if (this.startWSLNativeWatcher(sessionId, worktreePath)) {
          return;
        }
      }

      // Convert path for the watcher (needs platform-appropriate path)
      const watchPath = this.pathResolver ? this.pathResolver.toFileSystem(worktreePath) : worktreePath;

      // Function-form ignored: short-circuits descent into heavy directories
      // stats may be undefined on initial calls — return false (don't ignore) if unknown
      const ignored = (targetPath: string, stats?: Stats): boolean => {
        if (!stats) return false;
        const base = path.basename(targetPath);
        if (stats.isDirectory()) {
          return IGNORED_DIRS.has(base);
        }
        return IGNORED_FILE_PATTERNS.some((p) => p.test(base));
      };

      const worktreeWatcher = chokidarWatch(watchPath, {
        ignored,
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        awaitWriteFinish: false,
        usePolling: false,
        atomic: false,
      });

      worktreeWatcher.on('all', (_eventName, changedPath) => {
        const rel = path.relative(watchPath, changedPath) || changedPath;
        this.handleFileChange(sessionId, rel, 'change');
      });
      worktreeWatcher.on('error', (err) => {
        this.logger?.error(`[GitFileWatcher] worktree watcher error`, err as Error);
      });

      // Resolve the real gitdir. Pane sessions usually run in git
      // worktrees, where `.git` inside the worktree is a FILE
      // containing `gitdir: /path/to/main/.git/worktrees/<name>` — the
      // real `index` and `HEAD` live under that resolved path, not
      // under `<worktreePath>/.git`. Use `git rev-parse
      // --absolute-git-dir` so we get the correct location for both
      // worktrees and normal repos. If resolution fails (e.g., the
      // path is not yet a valid repo) we skip the narrow .git watcher
      // and rely on the worktree watcher alone.
      let gitWatcher: FSWatcher | undefined;
      try {
        const resolvedGitDir = this.execGit(
          'git rev-parse --absolute-git-dir',
          watchPath,
        ).trim();
        if (resolvedGitDir) {
          gitWatcher = chokidarWatch(
            [
              path.join(resolvedGitDir, 'index'),
              path.join(resolvedGitDir, 'HEAD'),
            ],
            {
              ignoreInitial: true,
              persistent: true,
              followSymlinks: false,
              usePolling: false,
            },
          );
          gitWatcher.on('all', () => {
            // intentional: bypass any ignore checks, always trigger on
            // git index/HEAD changes
            this.handleFileChange(sessionId, '.git/index', 'change');
          });
          gitWatcher.on('error', (err) => {
            this.logger?.error(
              `[GitFileWatcher] .git watcher error`,
              err as Error,
            );
          });
        }
      } catch (gitDirErr) {
        this.logger?.error(
          `[GitFileWatcher] Failed to resolve gitdir for ${sessionId}, ` +
            `narrow .git watcher disabled (metadata-only operations will ` +
            `not trigger refresh until worktree watcher fires):`,
          gitDirErr as Error,
        );
      }

      this.watchedSessions.set(sessionId, {
        sessionId,
        worktreePath,
        worktreeWatcher,
        gitWatcher,
        lastModified: Date.now(),
        pendingRefresh: false,
      });

      // Validation signal — keep in production: confirms watcher count is bounded
      this.logger?.info(
        `[GitFileWatcher] startWatching(${sessionId}) watchedSessions.size=${this.watchedSessions.size}`
      );
    } catch (error) {
      this.logger?.error(
        `[GitFileWatcher] Failed to start watching session ${sessionId}:`,
        error as Error
      );
    }
  }

  private startWSLNativeWatcher(sessionId: string, worktreePath: string): boolean {
    const distro = this.commandRunner?.wslContext?.distribution;
    if (!distro || process.platform !== 'win32') return false;

    const script = `
      set -e
      cd "$1"
      if ! command -v inotifywait >/dev/null 2>&1; then
        echo "__PANE_WSL_POLLING_FALLBACK__" >&2
        last="$(git status --porcelain=v1 --branch --untracked-files=normal 2>/dev/null || true)"
        while sleep 5; do
          current="$(git status --porcelain=v1 --branch --untracked-files=normal 2>/dev/null || true)"
          if [ "$current" != "$last" ]; then
            printf '%s\n' "__PANE_WSL_POLL__"
            last="$current"
          fi
        done
      fi
      gitdir="$(git rev-parse --absolute-git-dir 2>/dev/null || true)"
      watch_args=(.)
      if [ -n "$gitdir" ]; then
        [ -e "$gitdir/index" ] && watch_args+=("$gitdir/index")
        [ -e "$gitdir/HEAD" ] && watch_args+=("$gitdir/HEAD")
      fi
      exec inotifywait -m -r -q \
        -e modify,create,delete,move,attrib \
        --format '%w%f' \
        --exclude '(^|/)(node_modules|\\.git|\\.next|\\.nuxt|\\.turbo|\\.cache|\\.parcel-cache|\\.venv|venv|__pycache__|\\.svelte-kit)(/|$)' \
        "\${watch_args[@]}"
    `;

    const child = spawn('wsl.exe', ['-d', distro, '--', 'bash', '-lc', script, 'pane-wsl-watch', worktreePath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          this.handleFileChange(sessionId, line.trim(), 'change');
        }
      }
    });

    let pollingFallback = false;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (chunk.includes('__PANE_WSL_POLLING_FALLBACK__')) {
        pollingFallback = true;
        this.logger?.warn(
          `[GitFileWatcher] WSL native inotify unavailable for ${sessionId}; ` +
          `using WSL-native 5s git polling fallback. Install inotify-tools for lower battery use.`
        );
        return;
      }
      const message = chunk.trim();
      if (message) {
        this.logger?.warn(`[GitFileWatcher] WSL native watcher stderr for ${sessionId}: ${message}`);
      }
    });

    child.on('exit', (code, signal) => {
      const session = this.watchedSessions.get(sessionId);
      if (session?.wslWatcher === child) {
        this.watchedSessions.delete(sessionId);
      }
      if (code !== 0 && signal !== 'SIGTERM') {
        this.logger?.warn(`[GitFileWatcher] WSL native watcher exited for ${sessionId} with code=${code} signal=${signal ?? 'none'}`);
      }
    });

    child.on('error', (error) => {
      this.logger?.error(`[GitFileWatcher] Failed to start WSL native watcher for ${sessionId}:`, error);
    });

    this.watchedSessions.set(sessionId, {
      sessionId,
      worktreePath,
      wslWatcher: child,
      lastModified: Date.now(),
      pendingRefresh: false,
    });

    this.logger?.info(
      `[GitFileWatcher] startWatching(${sessionId}) using WSL native watcher; watchedSessions.size=${this.watchedSessions.size}` +
      (pollingFallback ? ' mode=polling' : '')
    );
    return true;
  }

  /**
   * Stop watching a session's worktree
   */
  stopWatching(sessionId: string): void {
    const session = this.watchedSessions.get(sessionId);
    if (!session) return;

    // fire-and-forget async close — keeps stopWatching synchronous from callers' perspective
    session.worktreeWatcher?.close().catch(() => {});
    session.gitWatcher?.close().catch(() => {});
    session.wslWatcher?.kill();
    this.watchedSessions.delete(sessionId);

    // Clear any pending refresh timer
    const timer = this.refreshDebounceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.refreshDebounceTimers.delete(sessionId);
    }

    this.logger?.info(`[GitFileWatcher] Stopped watching session ${sessionId}`);
  }

  /**
   * Stop all watchers
   */
  stopAll(): void {
    for (const sessionId of this.watchedSessions.keys()) {
      this.stopWatching(sessionId);
    }
  }

  /**
   * Handle a file change event
   */
  private handleFileChange(sessionId: string, _filename: string, _eventType: string): void {
    const session = this.watchedSessions.get(sessionId);
    if (!session) return;

    // Update last modified time
    session.lastModified = Date.now();
    session.pendingRefresh = true;

    // Debounce the refresh to batch rapid changes
    this.scheduleRefreshCheck(sessionId);
  }

  /**
   * Schedule a refresh check for a session
   */
  private scheduleRefreshCheck(sessionId: string): void {
    // Clear existing timer
    const existingTimer = this.refreshDebounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.refreshDebounceTimers.delete(sessionId);
      this.performRefreshCheck(sessionId);
    }, this.DEBOUNCE_MS);

    this.refreshDebounceTimers.set(sessionId, timer);
  }

  /**
   * Perform the actual refresh check using git plumbing commands
   */
  private performRefreshCheck(sessionId: string): void {
    const session = this.watchedSessions.get(sessionId);
    if (!session || !session.pendingRefresh) {
      return;
    }

    session.pendingRefresh = false;

    try {
      // Quick check if the index is dirty using git update-index
      // This is much faster than running full git status
      const needsRefresh = this.checkIfRefreshNeeded(session.worktreePath);

      if (needsRefresh) {
        this.logger?.info(`[GitFileWatcher] Session ${sessionId} needs refresh`);
        this.emit('needs-refresh', sessionId);
      } else {
        this.logger?.info(`[GitFileWatcher] Session ${sessionId} no refresh needed`);
      }
    } catch (error) {
      this.logger?.error(`[GitFileWatcher] Error checking session ${sessionId}:`, error as Error);
      // On error, emit refresh to be safe
      this.emit('needs-refresh', sessionId);
    }
  }

  /** Run a git command, using CommandRunner when available for WSL support */
  private execGit(command: string, cwd: string): string {
    if (this.commandRunner) {
      return this.commandRunner.exec(command, cwd, { silent: true });
    }
    return execSync(command, { cwd, encoding: 'utf8', silent: true }) as string;
  }

  /**
   * Quick check if git status needs refreshing
   * Returns true if there are changes, false if working tree is clean
   */
  private checkIfRefreshNeeded(worktreePath: string): boolean {
    try {
      // First, refresh the index to ensure it's up to date
      // This is very fast and updates git's internal cache
      this.execGit('git update-index --refresh --ignore-submodules', worktreePath);

      // Check for unstaged changes (modified files)
      try {
        this.execGit('git diff-files --quiet --ignore-submodules', worktreePath);
      } catch {
        // Non-zero exit means there are unstaged changes
        return true;
      }

      // Check for staged changes
      try {
        this.execGit('git diff-index --cached --quiet HEAD --ignore-submodules', worktreePath);
      } catch {
        // Non-zero exit means there are staged changes
        return true;
      }

      // Check for untracked files
      const untrackedOutput = this.execGit('git ls-files --others --exclude-standard', worktreePath).trim();

      if (untrackedOutput) {
        return true;
      }

      // Working tree is clean
      return false;
    } catch (error) {
      // If any command fails unexpectedly, assume refresh is needed
      this.logger?.error('[GitFileWatcher] Error in checkIfRefreshNeeded:', error as Error);
      return true;
    }
  }

  /**
   * Get statistics about watched sessions
   */
  getStats(): { totalWatched: number; sessionsNeedingRefresh: number } {
    let sessionsNeedingRefresh = 0;
    for (const session of this.watchedSessions.values()) {
      if (session.pendingRefresh) {
        sessionsNeedingRefresh++;
      }
    }

    return {
      totalWatched: this.watchedSessions.size,
      sessionsNeedingRefresh,
    };
  }
}
