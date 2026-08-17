import { EventEmitter } from 'events';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { getAppSubdirectory } from '../utils/appDirectory';
import { GitFileWatcher } from './gitFileWatcher';
import type { CommandRunner } from '../utils/commandRunner';
import type { PathResolver } from '../utils/pathResolver';
import type { SessionManager } from './sessionManager';
import type { Logger } from '../utils/logger';
import type { BrowserWindow } from 'electron';

interface SpotlightState {
  sessionId: string;
  projectId: number;
  projectPath: string;
  worktreePath: string;
  originalBranch: string;
  originalCommit: string;
  watcher: GitFileWatcher;
  commandRunner: CommandRunner;
  pathResolver: PathResolver;
  lastSyncCommit?: string;
  syncInProgress: boolean;
}

interface PersistedSpotlightEntry {
  sessionId: string;
  originalBranch: string;
  originalCommit: string;
}

interface PersistedSpotlightState {
  [projectId: string]: PersistedSpotlightEntry;
}

export class SpotlightManager extends EventEmitter {
  private activeSpotlights: Map<number, SpotlightState> = new Map();
  private readonly SPOTLIGHT_STATE_FILE: string;
  private readonly SPOTLIGHT_DEBOUNCE_MS = 2500;

  constructor(
    private sessionManager: SessionManager,
    private logger: Logger | undefined,
    private getMainWindow: () => BrowserWindow | null
  ) {
    super();
    this.SPOTLIGHT_STATE_FILE = getAppSubdirectory('spotlight-state.json');
    this.setMaxListeners(100);
  }

  enable(sessionId: string): void {
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
    if (!this.isRepoClean(project.path, commandRunner)) {
      throw new Error(
        'Project repository has uncommitted changes. Please commit or stash changes before enabling spotlight.'
      );
    }

    // Save original state
    const originalBranch = commandRunner.exec('git rev-parse --abbrev-ref HEAD', project.path, { silent: true }).trim();
    const originalCommit = commandRunner.exec('git rev-parse HEAD', project.path, { silent: true }).trim();

    this.logger?.info(`[SpotlightManager] Enabling spotlight for session ${sessionId} on project ${project.id}`);
    this.logger?.info(`[SpotlightManager] Original branch: ${originalBranch}, commit: ${originalCommit}`);

    // Do initial sync
    this.syncWorktreeToRoot(session.worktree_path, project.path, project.id);

    // Create watcher with WSL-aware command execution
    const watcher = new GitFileWatcher(this.logger, commandRunner, pathResolver);
    watcher.startWatching(sessionId, session.worktree_path);
    watcher.on('needs-refresh', () => {
      this.logger?.info(`[SpotlightManager] File change detected in session ${sessionId}, syncing...`);
      this.syncWorktreeToRoot(session.worktree_path, project.path, project.id);
    });

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
      pathResolver,
      syncInProgress: false
    };

    this.activeSpotlights.set(project.id, state);

    // Persist state
    this.persistState();

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

  disable(sessionId: string): void {
    // Find the active spotlight entry where state.sessionId === sessionId
    let state: SpotlightState | undefined;
    let projectId: number | undefined;

    for (const [pid, s] of this.activeSpotlights.entries()) {
      if (s.sessionId === sessionId) {
        state = s;
        projectId = pid;
        break;
      }
    }

    if (!state || projectId === undefined) {
      this.logger?.warn(`[SpotlightManager] No active spotlight found for session ${sessionId}`);
      return;
    }

    this.logger?.info(`[SpotlightManager] Disabling spotlight for session ${sessionId}`);

    // Stop watcher
    state.watcher.stopWatching(sessionId);
    state.watcher.stopAll();

    // Restore original state
    try {
      if (state.originalBranch === 'HEAD') {
        // Was detached
        this.logger?.info(`[SpotlightManager] Restoring detached HEAD state to ${state.originalCommit}`);
        state.commandRunner.exec(`git checkout ${state.originalCommit}`, state.projectPath, { silent: true });
      } else {
        // Was on a branch
        this.logger?.info(`[SpotlightManager] Restoring branch ${state.originalBranch}`);
        state.commandRunner.exec(`git checkout ${state.originalBranch}`, state.projectPath, { silent: true });
      }
    } catch (error) {
      this.logger?.error(
        `[SpotlightManager] Failed to restore original state for session ${sessionId}:`,
        new Error(String(error))
      );
      // Don't throw - we still want to clean up the spotlight state
    }

    // Remove from activeSpotlights
    this.activeSpotlights.delete(projectId);

    // Persist state
    this.persistState();

    // Notify frontend
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('spotlight:status-changed', {
        sessionId,
        projectId,
        active: false
      });
    }

    this.logger?.info(`[SpotlightManager] Spotlight disabled for session ${sessionId}`);
  }

  disableAll(): void {
    this.logger?.info('[SpotlightManager] Disabling all spotlights...');

    for (const [projectId, state] of this.activeSpotlights.entries()) {
      // Stop watcher
      state.watcher.stopWatching(state.sessionId);
      state.watcher.stopAll();

      // Restore original state
      try {
        if (state.originalBranch === 'HEAD') {
          // Was detached
          this.logger?.info(
            `[SpotlightManager] Restoring detached HEAD state to ${state.originalCommit} for project ${projectId}`
          );
          state.commandRunner.exec(`git checkout ${state.originalCommit}`, state.projectPath, { silent: true });
        } else {
          // Was on a branch
          this.logger?.info(
            `[SpotlightManager] Restoring branch ${state.originalBranch} for project ${projectId}`
          );
          state.commandRunner.exec(`git checkout ${state.originalBranch}`, state.projectPath, { silent: true });
        }
      } catch (error) {
        this.logger?.error(
          `[SpotlightManager] Failed to restore original state for project ${projectId}:`,
          new Error(String(error))
        );
        // Continue with other spotlights
      }
    }

    // Clear the map
    this.activeSpotlights.clear();

    // Delete persisted state file
    try {
      if (existsSync(this.SPOTLIGHT_STATE_FILE)) {
        unlinkSync(this.SPOTLIGHT_STATE_FILE);
      }
    } catch (error) {
      this.logger?.error('[SpotlightManager] Failed to delete state file:', new Error(String(error)));
    }

    this.logger?.info('[SpotlightManager] All spotlights disabled');
  }

  private syncWorktreeToRoot(worktreePath: string, projectPath: string, projectId: number): void {
    const state = this.activeSpotlights.get(projectId);
    if (!state) {
      return;
    }

    // Guard: if syncInProgress, return
    if (state.syncInProgress) {
      this.logger?.info(`[SpotlightManager] Sync already in progress for project ${projectId}, skipping`);
      return;
    }

    state.syncInProgress = true;

    try {
      // Tamper detection
      if (state.lastSyncCommit) {
        const currentCommit = state.commandRunner.exec('git rev-parse HEAD', projectPath, { silent: true }).trim();

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
          this.disable(state.sessionId);
          return;
        }
      }

      // Run git stash create
      const stashHash = state.commandRunner.exec('git stash create', worktreePath, { silent: true }).trim();

      // If empty string, no changes
      if (!stashHash) {
        this.logger?.info(`[SpotlightManager] No changes detected in worktree for project ${projectId}`);
        return;
      }

      this.logger?.info(`[SpotlightManager] Created stash ${stashHash} for project ${projectId}`);

      // Checkout the stash at project root
      state.commandRunner.exec(`git checkout ${stashHash}`, projectPath, { silent: true });

      // Update lastSyncCommit
      state.lastSyncCommit = stashHash;

      this.logger?.info(`[SpotlightManager] Successfully synced worktree to root for project ${projectId}`);
    } catch (error) {
      // Check for lock error
      if (String(error).includes('.lock')) {
        this.logger?.warn(`[SpotlightManager] Git lock detected for project ${projectId}, retrying in 1s...`);

        // Retry once after 1s delay
        setTimeout(() => {
          this.logger?.info(`[SpotlightManager] Retrying sync for project ${projectId}...`);
          state.syncInProgress = false;
          this.syncWorktreeToRoot(worktreePath, projectPath, projectId);
        }, 1000);
        return; // Don't set syncInProgress to false yet
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
    } finally {
      state.syncInProgress = false;
    }
  }

  private isRepoClean(repoPath: string, commandRunner: CommandRunner): boolean {
    try {
      commandRunner.exec('git diff-files --quiet', repoPath, { silent: true });
      commandRunner.exec('git diff-index --cached --quiet HEAD', repoPath, { silent: true });
      return true;
    } catch {
      return false;
    }
  }

  handleSessionDeleted(sessionId: string): void {
    // Check if this session is spotlighted
    for (const [_projectId, state] of this.activeSpotlights.entries()) {
      if (state.sessionId === sessionId) {
        this.logger?.info(`[SpotlightManager] Session ${sessionId} deleted, disabling spotlight`);
        this.disable(sessionId);
        break;
      }
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

  loadState(): void {
    try {
      if (existsSync(this.SPOTLIGHT_STATE_FILE)) {
        const contents = readFileSync(this.SPOTLIGHT_STATE_FILE, 'utf8');
        // We just read it for validation, actual restore happens in restoreAll
        JSON.parse(contents);
        this.logger?.info('[SpotlightManager] State file loaded successfully');
      }
    } catch (error) {
      this.logger?.error('[SpotlightManager] Failed to load state file:', new Error(String(error)));
    }
  }

  restoreAll(): void {
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
          this.enable(entry.sessionId);
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
