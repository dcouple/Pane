import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { getAppSubdirectory } from '../utils/appDirectory';
import { GitFileWatcher } from './gitFileWatcher';
import type { CommandRunner } from '../utils/commandRunner';
import type { SessionManager } from './sessionManager';
import type { Logger } from '../utils/logger';
import type { BrowserWindow } from 'electron';
import { withLock } from '../utils/mutex';

interface SpotlightState {
  sessionId: string;
  projectId: number;
  projectPath: string;
  worktreePath: string;
  originalBranch: string;
  originalCommit: string;
  watcher: GitFileWatcher;
  commandRunner: CommandRunner;
  lastSyncCommit?: string;
  syncPending?: Promise<void>;
  syncRequested?: boolean;
  stopping?: boolean;
  retryTimer?: NodeJS.Timeout;
}

interface PersistedSpotlightEntry {
  sessionId: string;
  originalBranch: string;
  originalCommit: string;
}

interface PersistedSpotlightState {
  [projectId: string]: PersistedSpotlightEntry;
}

export class SpotlightManager {
  private activeSpotlights: Map<number, SpotlightState> = new Map();
  private readonly SPOTLIGHT_STATE_FILE: string;

  constructor(
    private sessionManager: SessionManager,
    private logger: Logger | undefined,
    private getMainWindow: () => BrowserWindow | null
  ) {
    this.SPOTLIGHT_STATE_FILE = getAppSubdirectory('spotlight-state.json');
  }

  // Commands have their own deadlines. Lifecycle operations must wait for
  // checkout completion so a lock timeout cannot skip branch restoration.
  enable(sessionId: string): Promise<void> {
    return withLock(this.SPOTLIGHT_STATE_FILE, () => this.enableSpotlight(sessionId), Infinity);
  }

  private async enableSpotlight(sessionId: string): Promise<void> {
    const session = this.sessionManager.getDbSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!session.project_id) {
      throw new Error('Session does not have a project associated');
    }

    const project = this.sessionManager.getProjectForSession(sessionId);
    if (!project) {
      throw new Error(`Project for session ${sessionId} not found`);
    }

    const ctx = this.sessionManager.getProjectContextByProjectId(project.id);
    if (!ctx) {
      throw new Error(`Could not get project context for project ${project.id}`);
    }
    const { commandRunner, pathResolver } = ctx;

    // Validate worktree exists (use PathResolver for WSL UNC conversion)
    const fsWorktreePath = pathResolver.toFileSystem(session.worktree_path);
    if (!existsSync(fsWorktreePath)) {
      throw new Error(`Worktree path does not exist: ${session.worktree_path}`);
    }

    // One-per-project enforcement
    if (this.activeSpotlights.has(project.id)) {
      const existing = this.activeSpotlights.get(project.id);
      throw new Error(
        `Another session is already spotlighted for this project. Please disable session ${existing?.sessionId} first.`
      );
    }

    // Check repo clean
    if (!await this.isRepoClean(project.path, commandRunner)) {
      throw new Error(
        'Project repository has uncommitted changes. Please commit or stash changes before enabling spotlight.'
      );
    }

    // Save original state
    const originalBranch = (await commandRunner.execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], project.path, { silent: true })).stdout.trim();
    const originalCommit = (await commandRunner.execFile('git', ['rev-parse', 'HEAD'], project.path, { silent: true })).stdout.trim();

    this.logger?.info(`[SpotlightManager] Enabling spotlight for session ${sessionId} on project ${project.id}`);
    this.logger?.info(`[SpotlightManager] Original branch: ${originalBranch}, commit: ${originalCommit}`);

    const watcher = new GitFileWatcher(this.logger, commandRunner, pathResolver);

    // Store in activeSpotlights
    const state: SpotlightState = {
      sessionId,
      projectId: project.id,
      projectPath: project.path,
      worktreePath: session.worktree_path,
      originalBranch,
      originalCommit,
      watcher,
      commandRunner,
    };

    this.activeSpotlights.set(project.id, state);
    // Record the original branch before the first checkout so disable/shutdown
    // always use the same restore path, including during initial activation.
    this.persistState();
    await this.syncWorktreeToRoot(state);
    if (this.activeSpotlights.get(project.id) !== state) return;
    watcher.on('needs-refresh', () => { void this.requestSync(state); });
    await watcher.startWatching(sessionId, session.worktree_path);

    // Notify frontend
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('spotlight:status-changed', {
        sessionId,
        projectId: project.id,
        active: true
      });
    }

    this.logger?.info(`[SpotlightManager] Spotlight enabled for session ${sessionId}`);
  }

  disable(sessionId: string): Promise<void> {
    const active = [...this.activeSpotlights.values()].find(entry => entry.sessionId === sessionId);
    if (active) active.stopping = true;
    return withLock(this.SPOTLIGHT_STATE_FILE, async () => {
      const state = [...this.activeSpotlights.values()].find(entry => entry.sessionId === sessionId);
      if (state) await this.disableSpotlight(state);
    }, Infinity);
  }

  private async disableSpotlight(state: SpotlightState): Promise<void> {
    const { sessionId, projectId } = state;
    state.watcher.stopAll();
    if (state.retryTimer) clearTimeout(state.retryTimer);
    this.activeSpotlights.delete(projectId);

    try {
      const target = state.originalBranch === 'HEAD' ? state.originalCommit : state.originalBranch;
      await state.commandRunner.execFile('git', ['checkout', target], state.projectPath, { silent: true });
    } catch (error) {
      this.logger?.error(
        `[SpotlightManager] Failed to restore original state for session ${sessionId}:`,
        new Error(String(error)),
      );
    }

    this.persistState();
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('spotlight:status-changed', { sessionId, projectId, active: false });
    }
  }

  disableAll(): Promise<void> {
    for (const state of this.activeSpotlights.values()) state.stopping = true;
    return withLock(this.SPOTLIGHT_STATE_FILE, async () => {
      for (const state of this.activeSpotlights.values()) await this.disableSpotlight(state);
      try {
        if (existsSync(this.SPOTLIGHT_STATE_FILE)) unlinkSync(this.SPOTLIGHT_STATE_FILE);
      } catch (error) {
        this.logger?.error('[SpotlightManager] Failed to delete state file:', new Error(String(error)));
      }
    }, Infinity);
  }

  private requestSync(state: SpotlightState, retry = false): Promise<void> {
    if (state.stopping) return Promise.resolve();
    state.syncRequested = true;
    if (state.syncPending) return state.syncPending;
    const pending = withLock(this.SPOTLIGHT_STATE_FILE, async () => {
      // A queued sync must never checkout after disable or after replacement.
      while (state.syncRequested && !state.stopping && this.activeSpotlights.get(state.projectId) === state) {
        state.syncRequested = false;
        await this.syncWorktreeToRoot(state, retry);
      }
    }, Infinity).catch(error => {
      this.logger?.error('[SpotlightManager] Failed to schedule sync:', new Error(String(error)));
    }).finally(() => {
      if (state.syncPending === pending) state.syncPending = undefined;
    });
    state.syncPending = pending;
    return pending;
  }

  private async syncWorktreeToRoot(state: SpotlightState, retry = false): Promise<void> {
    const { projectId, projectPath, worktreePath } = state;
    try {
      // Tamper detection
      if (state.lastSyncCommit) {
        const currentCommit = (await state.commandRunner.execFile('git', ['rev-parse', 'HEAD'], projectPath, { silent: true })).stdout.trim();

        if (currentCommit !== state.lastSyncCommit) {
          this.logger?.warn(
            `[SpotlightManager] Tamper detected! Root repo was modified externally. Auto-disabling spotlight for session ${state.sessionId}`
          );

          // Send warning event
          const mainWindow = this.getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('spotlight:tamper-detected', {
              sessionId: state.sessionId,
              projectId,
              message: 'Root repository was modified externally. Spotlight has been disabled.'
            });
          }

          // Auto-disable
          await this.disableSpotlight(state);
          return;
        }
      }

      // Run git stash create
      const stashHash = (await state.commandRunner.execFile('git', ['stash', 'create'], worktreePath, { silent: true })).stdout.trim();

      // If empty string, no changes
      if (!stashHash) {
        this.logger?.info(`[SpotlightManager] No changes detected in worktree for project ${projectId}`);
        return;
      }

      this.logger?.info(`[SpotlightManager] Created stash ${stashHash} for project ${projectId}`);

      // Checkout the stash at project root
      await state.commandRunner.execFile('git', ['checkout', stashHash], projectPath, { silent: true });

      // Update lastSyncCommit
      state.lastSyncCommit = stashHash;

      this.logger?.info(`[SpotlightManager] Successfully synced worktree to root for project ${projectId}`);
    } catch (error) {
      // Check for lock error
      if (!retry && !state.retryTimer && String(error).includes('.lock')) {
        this.logger?.warn(`[SpotlightManager] Git lock detected for project ${projectId}, retrying in 1s...`);

        // Retry once after 1s delay
        state.retryTimer = setTimeout(() => {
          this.logger?.info(`[SpotlightManager] Retrying sync for project ${projectId}...`);
          state.retryTimer = undefined;
          void this.requestSync(state, true);
        }, 1000);
        return;
      }

      this.logger?.error(`[SpotlightManager] Sync error for project ${projectId}:`, new Error(String(error)));

      // Send sync error event
      const mainWindow = this.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('spotlight:sync-error', {
          sessionId: state.sessionId,
          projectId,
          error: String(error)
        });
      }
    }
  }

  private async isRepoClean(repoPath: string, commandRunner: CommandRunner): Promise<boolean> {
    try {
      await commandRunner.execFile('git', ['diff-files', '--quiet'], repoPath, { silent: true });
      await commandRunner.execFile('git', ['diff-index', '--cached', '--quiet', 'HEAD'], repoPath, { silent: true });
      return true;
    } catch {
      return false;
    }
  }

  getActiveSpotlight(projectId: number): { sessionId: string; active: boolean } | null {
    if (this.activeSpotlights.has(projectId)) {
      const state = this.activeSpotlights.get(projectId);
      if (state) {
        return { sessionId: state.sessionId, active: true };
      }
    }
    return null;
  }

  isSpotlightActive(sessionId: string): boolean {
    for (const state of this.activeSpotlights.values()) {
      if (state.sessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  private persistState(): void {
    const persisted: PersistedSpotlightState = {};
    for (const [projectId, state] of this.activeSpotlights) {
      persisted[String(projectId)] = {
        sessionId: state.sessionId,
        originalBranch: state.originalBranch,
        originalCommit: state.originalCommit
      };
    }

    try {
      const dir = dirname(this.SPOTLIGHT_STATE_FILE);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.SPOTLIGHT_STATE_FILE, JSON.stringify(persisted, null, 2));
      this.logger?.info('[SpotlightManager] State persisted successfully');
    } catch (error) {
      this.logger?.error('[SpotlightManager] Failed to persist state:', new Error(String(error)));
    }
  }

  async restoreAll(): Promise<void> {
    try {
      if (!existsSync(this.SPOTLIGHT_STATE_FILE)) {
        this.logger?.info('[SpotlightManager] No state file to restore');
        return;
      }

      const contents = readFileSync(this.SPOTLIGHT_STATE_FILE, 'utf8');
      const persisted: PersistedSpotlightState = JSON.parse(contents);

      this.logger?.info('[SpotlightManager] Restoring spotlight state...');

      for (const [projectIdStr, entry] of Object.entries(persisted)) {
        try {
          // Validate session still exists
          const session = this.sessionManager.getDbSession(entry.sessionId);
          if (!session) {
            this.logger?.warn(`[SpotlightManager] Session ${entry.sessionId} no longer exists, skipping restore`);
            continue;
          }

          // Validate worktree exists (use PathResolver for WSL UNC conversion)
          const ctx = this.sessionManager.getProjectContextByProjectId(Number(projectIdStr));
          const fsWorktreePath = ctx
            ? ctx.pathResolver.toFileSystem(session.worktree_path)
            : session.worktree_path;
          if (!existsSync(fsWorktreePath)) {
            this.logger?.warn(
              `[SpotlightManager] Worktree for session ${entry.sessionId} no longer exists, skipping restore`
            );
            continue;
          }

          // Re-enable spotlight
          this.logger?.info(`[SpotlightManager] Restoring spotlight for session ${entry.sessionId}`);
          await this.enable(entry.sessionId);
        } catch (error) {
          this.logger?.error(
            `[SpotlightManager] Failed to restore spotlight for project ${projectIdStr}:`,
            new Error(String(error))
          );
          // Continue with other entries
        }
      }

      this.logger?.info('[SpotlightManager] Spotlight state restoration complete');
    } catch (error) {
      this.logger?.error('[SpotlightManager] Failed to restore spotlight state:', new Error(String(error)));
    }
  }
}
