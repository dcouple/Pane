import { powerMonitor, type App, type BrowserWindow } from 'electron';
import { startupRetentionResult } from '../services/database';
import { ConfigManager } from '../services/configManager';
import { Logger } from '../utils/logger';
import { DatabaseService } from '../database/database';
import { AnalyticsManager } from '../services/analyticsManager';
import { SessionManager } from '../services/sessionManager';
import { ArchiveProgressManager } from '../services/archiveProgressManager';
import { SpotlightManager } from '../services/spotlightManager';
import { PermissionIpcServer } from '../services/permissionIpcServer';
import { WorktreeManager } from '../services/worktreeManager';
import { CliManagerFactory } from '../services/cliManagerFactory';
import type { AbstractCliManager } from '../services/panels/cli/AbstractCliManager';
import { GitDiffManager } from '../services/gitDiffManager';
import { GitStatusManager } from '../services/gitStatusManager';
import { ExecutionTracker } from '../services/executionTracker';
import { WorktreeNameGenerator } from '../services/worktreeNameGenerator';
import { RunCommandManager } from '../services/runCommandManager';
import { VersionChecker } from '../services/versionChecker';
import { TaskQueue } from '../services/taskQueue';
import { registerIpcHandlers } from '../ipc';
import { PaneDaemonServer } from './server';
import { PaneRemoteHttpApiServer } from './httpApiServer';
import { createFanoutEventSink, noopPaneEventSink, type PaneEventSink } from '../core/eventSink';
import {
  setPaneRuntime,
  type PaneWebviewContext,
  type PtyHostRuntime,
} from '../core/runtime';
import type { AppServices, DaemonHostServices } from '../ipc/types';
import { setupEventListeners } from '../events';
import { getAppDirectory } from '../utils/appDirectory';
import { resourceMonitorService } from '../services/resourceMonitorService';
import type { PaneCommandRegistry } from './commandRegistry';

interface PaneDaemonHostOptions {
  app: App;
  getMainWindow: () => BrowserWindow | null;
  getPtyHostRuntime: () => PtyHostRuntime | null;
  getWebviewContextMap?: () => Map<number, PaneWebviewContext>;
  rendererEventSink?: PaneEventSink;
  mode?: 'desktop' | 'headless';
  restoreSpotlights?: boolean;
  startRemoteTransport?: boolean;
}

export interface PaneDaemonHost {
  services: AppServices;
  daemonServices: DaemonHostServices;
  commandRegistry: PaneCommandRegistry;
  paneDaemonServer: PaneDaemonServer | null;
  remoteHttpApiServer: PaneRemoteHttpApiServer | null;
  permissionIpcServer: PermissionIpcServer | null;
  shutdown(): Promise<void>;
}

let powerMonitorDiagnosticsRegistered = false;

function installPaneRuntime(
  eventSink: PaneEventSink,
  configManager: ConfigManager,
  getPtyHostRuntime: () => PtyHostRuntime | null,
  getWebviewContextMap: () => Map<number, PaneWebviewContext>,
  daemonEventSink?: PaneEventSink,
): void {
  setPaneRuntime({
    eventSink,
    daemonEventSink,
    getConfigManager: () => configManager,
    getPtyHostRuntime,
    getWebviewContextMap,
  });
}

function registerPowerMonitorDiagnostics(logger: Logger): void {
  if (powerMonitorDiagnosticsRegistered) {
    return;
  }

  powerMonitorDiagnosticsRegistered = true;
  powerMonitor.on('suspend', () => logger.info('[Lifecycle] power:suspend'));
  powerMonitor.on('resume', () => logger.info('[Lifecycle] power:resume'));
  powerMonitor.on('lock-screen', () => logger.info('[Lifecycle] power:lock-screen'));
  powerMonitor.on('unlock-screen', () => logger.info('[Lifecycle] power:unlock-screen'));
}

export async function createPaneDaemonHost(options: PaneDaemonHostOptions): Promise<PaneDaemonHost> {
  const mode = options.mode ?? 'desktop';
  const startRemoteTransport = options.startRemoteTransport ?? true;
  const rendererEventSink = options.rendererEventSink ?? noopPaneEventSink;
  const headlessWebviewContextMap = new Map<number, PaneWebviewContext>();
  const getWebviewContextMap = options.getWebviewContextMap ?? (() => headlessWebviewContextMap);

  const configManager = new ConfigManager();
  await configManager.initialize();
  installPaneRuntime(rendererEventSink, configManager, options.getPtyHostRuntime, getWebviewContextMap);

  const logger = new Logger(configManager);
  console.log('[Main] Logger initialized with file logging to ~/.pane/logs');
  registerPowerMonitorDiagnostics(logger);

  if (startupRetentionResult.error) {
    logger.error('[ScrollbackRetention] Sweep failed', startupRetentionResult.error);
  } else if (startupRetentionResult.result && startupRetentionResult.result.panelsCleared > 0) {
    const result = startupRetentionResult.result;
    logger.info(
      `[ScrollbackRetention] Cleared ${result.panelsCleared} panels across ` +
      `${result.sessionsTouched} sessions, freed ~${(result.bytesFreed / 1_000_000).toFixed(1)} MB`,
    );
  }

  const dbPath = configManager.getDatabasePath();
  const databaseService = new DatabaseService(dbPath);
  databaseService.initialize();

  const analyticsManager = new AnalyticsManager(configManager);
  const sessionManager = new SessionManager(databaseService, analyticsManager);
  sessionManager.initializeFromDatabase();

  if (process.platform === 'win32') {
    const wslDistros = databaseService.getAllProjects()
      .filter((project) => project.wsl_enabled && project.wsl_distribution)
      .map((project) => project.wsl_distribution!);
    if (wslDistros.length > 0) {
      void import('../utils/wslUtils').then(({ bumpWSLInotifyLimits }) =>
        bumpWSLInotifyLimits(wslDistros).catch(() => {}),
      );
    }
  }

  const archiveProgressManager = new ArchiveProgressManager();
  const spotlightManager = new SpotlightManager(sessionManager, logger, options.getMainWindow);

  console.log('[Main] Initializing Permission IPC server...');
  let permissionIpcServer: PermissionIpcServer | null = new PermissionIpcServer();
  console.log('[Main] Starting Permission IPC server...');
  let permissionIpcPath: string | null = null;

  try {
    await permissionIpcServer.start();
    permissionIpcPath = permissionIpcServer.getSocketPath();
    console.log('[Main] Permission IPC server started successfully');
    console.log('[Main] Permission IPC socket path:', permissionIpcPath);
  } catch (error) {
    console.error('[Main] Failed to start Permission IPC server:', error);
    console.error('[Main] Permission-based MCP will be disabled');
    permissionIpcServer = null;
  }

  const worktreeManager = new WorktreeManager(configManager, analyticsManager);
  const activeProject = sessionManager.getActiveProject();
  if (activeProject) {
    const context = sessionManager.getProjectContextByProjectId(activeProject.id);
    if (context) {
      await worktreeManager.initializeProject(activeProject.path, undefined, context.pathResolver, context.commandRunner);
    }
  }

  const cliManagerFactory = CliManagerFactory.getInstance(logger, configManager);
  const defaultCliManager: AbstractCliManager = await cliManagerFactory.createManager('claude', {
    sessionManager,
    logger,
    configManager,
    additionalOptions: { permissionIpcPath },
    skipValidation: true,
  });
  const gitDiffManager = new GitDiffManager(logger, analyticsManager);
  const gitStatusManager = new GitStatusManager(sessionManager, worktreeManager, gitDiffManager, logger);
  const executionTracker = new ExecutionTracker(sessionManager, gitDiffManager);
  const worktreeNameGenerator = new WorktreeNameGenerator(configManager);
  const runCommandManager = new RunCommandManager(databaseService);
  const versionChecker = new VersionChecker(configManager, logger);
  const taskQueue = new TaskQueue({
    sessionManager,
    worktreeManager,
    claudeCodeManager: defaultCliManager,
    gitDiffManager,
    executionTracker,
    worktreeNameGenerator,
  });

  const daemonServices: DaemonHostServices = {
    configManager,
    databaseService,
    sessionManager,
    worktreeManager,
    cliManagerFactory,
    claudeCodeManager: defaultCliManager,
    gitDiffManager,
    gitStatusManager,
    executionTracker,
    worktreeNameGenerator,
    runCommandManager,
    versionChecker,
    taskQueue,
    getMainWindow: options.getMainWindow,
    logger,
    archiveProgressManager,
    analyticsManager,
    spotlightManager,
  };

  const services: AppServices = {
    app: options.app,
    ...daemonServices,
  };

  const commandRegistry = registerIpcHandlers(services);

  let paneDaemonServer: PaneDaemonServer | null = null;
  let remoteHttpApiServer: PaneRemoteHttpApiServer | null = null;
  try {
    paneDaemonServer = new PaneDaemonServer(commandRegistry, getAppDirectory());
    await paneDaemonServer.start();
  } catch (error) {
    console.error('[Pane daemon] Failed to start local daemon server; continuing with renderer-only runtime events', error);
  }

  if (startRemoteTransport && configManager.getConfig().remoteDaemon?.host.config.enabled) {
    try {
      remoteHttpApiServer = new PaneRemoteHttpApiServer(commandRegistry, configManager);
      await remoteHttpApiServer.start();
    } catch (error) {
      console.error('[Pane remote daemon] Failed to start remote HTTP transport; continuing without remote access', error);
      remoteHttpApiServer = null;
    }
  }

  const daemonSinks: PaneEventSink[] = [];
  if (paneDaemonServer) {
    daemonSinks.push(paneDaemonServer.getEventSink());
  }
  if (remoteHttpApiServer) {
    daemonSinks.push(remoteHttpApiServer.getEventSink());
  }

  installPaneRuntime(
    createFanoutEventSink([rendererEventSink, ...daemonSinks]),
    configManager,
    options.getPtyHostRuntime,
    getWebviewContextMap,
    createFanoutEventSink(daemonSinks),
  );

  setupEventListeners(services);

  const { logsManager } = await import('../services/panels/logPanel/logsManager');
  logsManager.setAnalyticsManager(analyticsManager);

  gitStatusManager.startPolling();
  if (mode === 'desktop') {
    versionChecker.startPeriodicCheck();
  }
  resourceMonitorService.initialize({
    app: options.app,
    getSessionById: (sessionId) => sessionManager.getSession(sessionId),
  });

  if (options.restoreSpotlights !== false) {
    try {
      spotlightManager.restoreAll();
    } catch (error) {
      console.error('[Main] Failed to restore spotlight state:', error);
    }
  }

  return {
    services,
    daemonServices,
    commandRegistry,
    paneDaemonServer,
    remoteHttpApiServer,
    permissionIpcServer,
    async shutdown(): Promise<void> {
      resourceMonitorService.stop();
      spotlightManager.disableAll();
      await sessionManager.cleanup();
      await runCommandManager.stopAllRunCommands();
      gitStatusManager.stopPolling();
      configManager.stopWatching();
      await cliManagerFactory.shutdown();
      await taskQueue.close();
      await permissionIpcServer?.stop();
      await remoteHttpApiServer?.stop();
      if (paneDaemonServer) {
        await paneDaemonServer.stop();
      }
      versionChecker.stopPeriodicCheck();
      logger.close();
    },
  };
}
