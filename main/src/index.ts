// Load ReadableStream polyfill before any other imports
import './polyfills/readablestream';

// Fix GTK 2/3 and GTK 4 conflict on Linux (Electron 36 issue)
// This MUST be done before importing electron
import { app } from 'electron';
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('gtk-version', '3');
}

// Force integrated GPU for better battery life on dual-GPU systems
app.commandLine.appendSwitch('force_discrete_gpu', '0');

// Now import the rest of electron
import { BrowserWindow, ipcMain, shell, dialog, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import * as os from 'os';
import { TaskQueue } from './services/taskQueue';
import { SessionManager } from './services/sessionManager';
import { ConfigManager } from './services/configManager';
import { WorktreeManager } from './services/worktreeManager';
import { WorktreeNameGenerator } from './services/worktreeNameGenerator';
import { GitDiffManager } from './services/gitDiffManager';
import { GitStatusManager } from './services/gitStatusManager';
import { ExecutionTracker } from './services/executionTracker';
import { DatabaseService } from './database/database';
import { RunCommandManager } from './services/runCommandManager';
import { PermissionIpcServer } from './services/permissionIpcServer';
import { VersionChecker } from './services/versionChecker';
import { Logger } from './utils/logger';
import { ArchiveProgressManager } from './services/archiveProgressManager';
import { AnalyticsManager } from './services/analyticsManager';
import { SpotlightManager } from './services/spotlightManager';
import { initializeCommitManager } from './services/commitManager';
import { resourceMonitorService } from './services/resourceMonitorService';
import { setAppDirectory, migrateDataDirectory } from './utils/appDirectory';
import { getCurrentWorktreeName } from './utils/worktreeUtils';
import { registerIpcHandlers } from './ipc';
import { setupAutoUpdater } from './autoUpdater';
import { setupEventListeners } from './events';
import { AppServices } from './ipc/types';
import { getCloudVmManager } from './ipc/cloud';
import { CliManagerFactory } from './services/cliManagerFactory';
import { AbstractCliManager } from './services/panels/cli/AbstractCliManager';
import { setupConsoleWrapper } from './utils/consoleWrapper';
import * as fs from 'fs';
import { terminalPanelManager } from './services/terminalPanelManager';
import { panelManager } from './services/panelManager';
import { TerminalPanelState } from '../../shared/types/panels';

export let mainWindow: BrowserWindow | null = null;

// Module-level shutdown guard to prevent multiple shutdown attempts
let shutdownInProgress = false;

/**
 * Set the application title based on development mode and worktree
 */
function setAppTitle() {
  if (!app.isPackaged) {
    const worktreeName = getCurrentWorktreeName(process.cwd());
    if (worktreeName) {
      const title = `Pane [${worktreeName}]`;
      if (mainWindow) {
        mainWindow.setTitle(title);
      }
      return title;
    }
  }
  
  // Default title
  const title = 'Pane';
  if (mainWindow) {
    mainWindow.setTitle(title);
  }
  return title;
}
let taskQueue: TaskQueue | null = null;

// Service instances (configManager exported for shell preference access)
export let configManager: ConfigManager;
let logger: Logger;
export let sessionManager: SessionManager;
let worktreeManager: WorktreeManager;
let cliManagerFactory: CliManagerFactory;
let defaultCliManager: AbstractCliManager;
let gitDiffManager: GitDiffManager;
let gitStatusManager: GitStatusManager;
let executionTracker: ExecutionTracker;
let worktreeNameGenerator: WorktreeNameGenerator;
let databaseService: DatabaseService;
let runCommandManager: RunCommandManager;
let permissionIpcServer: PermissionIpcServer | null;
let versionChecker: VersionChecker;
let archiveProgressManager: ArchiveProgressManager;
let analyticsManager: AnalyticsManager;
let spotlightManager: SpotlightManager;

// Store app start time for session duration tracking
let appStartTime: number;

// Store original console methods before overriding
// These must be captured immediately when the module loads
const originalLog: typeof console.log = console.log;
const originalError: typeof console.error = console.error;
const originalWarn: typeof console.warn = console.warn;
const originalInfo: typeof console.info = console.info;

const isDevelopment = process.env.NODE_ENV !== 'production' && !app.isPackaged;

// Reset debug log files at startup in development mode
if (isDevelopment) {
  const frontendLogPath = path.join(process.cwd(), 'frontend-debug.log');
  const backendLogPath = path.join(process.cwd(), 'backend-debug.log');

  try {
    fs.writeFileSync(frontendLogPath, '');
    fs.writeFileSync(backendLogPath, '');
  } catch (error) {
    // Don't crash if we can't reset the log files
    console.error('Failed to reset debug log files:', error);
  }
}

// Set up console wrapper to reduce logging in production
setupConsoleWrapper();

// Parse command-line arguments for custom Pane directory
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  
  // Support both --pane-dir=/path and --pane-dir /path formats
  if (arg.startsWith('--pane-dir=')) {
    const dir = arg.substring('--pane-dir='.length);
    setAppDirectory(dir);
    console.log(`[Main] Using custom Pane directory: ${dir}`);
  } else if (arg === '--pane-dir' && i + 1 < args.length) {
    const dir = args[i + 1];
    setAppDirectory(dir);
    console.log(`[Main] Using custom Pane directory: ${dir}`);
    i++; // Skip the next argument since we've consumed it
  }
  // Deprecated: support old --foozol-dir for backward compatibility
  else if (arg.startsWith('--foozol-dir=')) {
    const dir = arg.substring('--foozol-dir='.length);
    setAppDirectory(dir);
    console.log(`[Main] Using custom Pane directory (deprecated --foozol-dir): ${dir}`);
  } else if (arg === '--foozol-dir' && i + 1 < args.length) {
    const dir = args[i + 1];
    setAppDirectory(dir);
    console.log(`[Main] Using custom Pane directory (deprecated --foozol-dir): ${dir}`);
    i++;
  }
}

// Migrate data directory from ~/.foozol to ~/.pane (one-time migration for existing users)
migrateDataDirectory();

// Install Devtron in development
if (isDevelopment) {
  // Devtron can be installed manually in DevTools console with: require('devtron').install()
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 10, y: 10 }
    } : {})
  });

  // Set main window on analytics manager for IPC forwarding
  if (analyticsManager) {
    analyticsManager.setMainWindow(mainWindow);
  }

  // Increase max listeners to prevent warning when many panels are active
  // Each panel can register multiple event listeners
  mainWindow.webContents.setMaxListeners(100);

  // Prevent Ctrl+W / Cmd+W from closing the Electron window so the renderer
  // can use it to close tabs. We intercept at before-input-event and re-emit
  // the key as a DOM keydown via IPC so the renderer's hotkey system sees it.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && input.key.toLowerCase() === 'w' && input.type === 'keyDown') {
      event.preventDefault();
      mainWindow?.webContents.send('synthetic-keydown', {
        key: 'w',
        ctrlKey: input.control,
        metaKey: input.meta,
        shiftKey: input.shift,
        altKey: input.alt,
      });
    }
  });

  if (isDevelopment) {
    const devPort = process.env.VITE_PORT || process.env.PORT || '4521';
    await mainWindow.loadURL(`http://localhost:${devPort}`);
    mainWindow.webContents.openDevTools();
    
    // Enable IPC debugging in development
    
    // Log all IPC calls in main process
    const originalHandle = ipcMain.handle;
    ipcMain.handle = function(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown) {
      const wrappedListener = async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (channel.startsWith('stravu:')) {
        }
        const result = await listener(event, ...args);
        if (channel.startsWith('stravu:')) {
        }
        return result;
      };
      return originalHandle.call(this, channel, wrappedListener);
    };
  } else {
    // In production, use app.getAppPath() to get the root directory
    // This works correctly whether the app is packaged in ASAR or not
    const indexPath = path.join(app.getAppPath(), 'frontend/dist/index.html');
    console.log('Loading index.html from:', indexPath);

    try {
      await mainWindow.loadFile(indexPath);
    } catch (error) {
      console.error('Failed to load index.html:', error);
      console.error('App path:', app.getAppPath());
      console.error('__dirname:', __dirname);
      
      // Fallback: try relative path (for edge cases)
      const fallbackPath = path.join(__dirname, '../../../../frontend/dist/index.html');
      console.error('Trying fallback path:', fallbackPath);
      try {
        await mainWindow.loadFile(fallbackPath);
      } catch (fallbackError) {
        console.error('Fallback path also failed:', fallbackError);
      }
    }
  }

  // Set the app title based on development mode and worktree
  setAppTitle();

  // Apply persisted UI scale
  const uiScale = configManager.getConfig().uiScale;
  if (uiScale && uiScale !== 1.0) {
    mainWindow.webContents.setZoomFactor(uiScale);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Log any console messages from the renderer
  mainWindow.webContents.on('console-message', (event) => {
    const { level, message, lineNumber, sourceId } = event;
    // Skip messages that are already prefixed to avoid circular logging
    if (message.includes('[Main Process]') || message.includes('[Renderer]')) {
      return;
    }
    // Also skip Electron security warnings and other system messages
    if (message.includes('Electron Security Warning') || sourceId.includes('electron/js2c')) {
      return;
    }

    // In development, log ALL console messages to help with debugging
    if (isDevelopment) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [FRONTEND ${level.toUpperCase()}] ${message}`;

      // Also write to debug log file for Claude Code to read
      const debugLogPath = path.join(process.cwd(), 'frontend-debug.log');
      const logLine = `${logMessage} (${path.basename(sourceId)}:${lineNumber})\n`;

      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        console.error('Failed to write to debug log:', error);
      }
    }
  });

  // Override console methods to forward to renderer and logger
  console.log = (...args: unknown[]) => {
    // Format the message
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');

    // Write to logger if available
    if (logger) {
      logger.info(message);
    } else {
      originalLog.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [BACKEND LOG] ${message}`;
      const debugLogPath = path.join(process.cwd(), 'backend-debug.log');
      const logLine = `${logMessage}\n`;

      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        originalLog('[Main] Failed to write to backend debug log:', error);
      }
    }

    // Forward to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'log', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalLog('[Main] Failed to send log to renderer:', e);
      }
    }
  };

  console.error = (...args: unknown[]) => {
    // Prevent infinite recursion by checking if we're already in an error handler
    if ((console.error as typeof console.error & { __isHandlingError?: boolean }).__isHandlingError) {
      return originalError.apply(console, args);
    }
    
    (console.error as typeof console.error & { __isHandlingError?: boolean }).__isHandlingError = true;
    
    try {
      // If logger is not initialized or we're in the logger itself, use original console
      if (!logger) {
        originalError.apply(console, args);
        return;
      }

      const message = args.map(arg => {
        if (typeof arg === 'object' && arg !== null) {
          if (arg instanceof Error) {
            return `Error: ${arg.message}\nStack: ${arg.stack}`;
          }
          try {
            return JSON.stringify(arg, null, 2);
          } catch (e) {
            // Handle circular structure
            return `[Object with circular structure: ${arg.constructor?.name || 'Object'}]`;
          }
        }
        return String(arg);
      }).join(' ');

      // Extract Error object if present
      const errorObj = args.find(arg => arg instanceof Error) as Error | undefined;

      // Use logger but with recursion protection
      logger.error(message, errorObj);

      // In development, also write to backend debug log file
      if (isDevelopment) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [BACKEND ERROR] ${message}`;
        const debugLogPath = path.join(process.cwd(), 'backend-debug.log');
        const logLine = `${logMessage}\n`;

        try {
          fs.appendFileSync(debugLogPath, logLine);
        } catch (error) {
          // Don't crash if we can't write to the log file
          originalError('[Main] Failed to write to backend debug log:', error);
        }
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.webContents.send('main-log', 'error', message);
        } catch (e) {
          // If sending to renderer fails, use original console to avoid recursion
          originalError('[Main] Failed to send error to renderer:', e);
        }
      }
    } catch (e) {
      // If anything fails in the error handler, fall back to original
      originalError.apply(console, args);
    } finally {
      (console.error as typeof console.error & { __isHandlingError?: boolean }).__isHandlingError = false;
    }
  };

  console.warn = (...args: unknown[]) => {
    const message = args.map(arg => {
      if (typeof arg === 'object' && arg !== null) {
        if (arg instanceof Error) {
          return `Error: ${arg.message}\nStack: ${arg.stack}`;
        }
        try {
          return JSON.stringify(arg, null, 2);
        } catch (e) {
          // Handle circular structure
          return `[Object with circular structure: ${arg.constructor?.name || 'Object'}]`;
        }
      }
      return String(arg);
    }).join(' ');

    // Extract Error object if present for warnings too
    const errorObj = args.find(arg => arg instanceof Error) as Error | undefined;

    if (logger) {
      logger.warn(message, errorObj);
    } else {
      originalWarn.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [BACKEND WARNING] ${message}`;
      const debugLogPath = path.join(process.cwd(), 'backend-debug.log');
      const logLine = `${logMessage}\n`;

      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        originalWarn('[Main] Failed to write to backend debug log:', error);
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'warn', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalWarn('[Main] Failed to send warning to renderer:', e);
      }
    }
  };

  console.info = (...args: unknown[]) => {
    const message = args.map(arg => {
      if (typeof arg === 'object' && arg !== null) {
        if (arg instanceof Error) {
          return `Error: ${arg.message}\nStack: ${arg.stack}`;
        }
        try {
          return JSON.stringify(arg, null, 2);
        } catch (e) {
          // Handle circular structure
          return `[Object with circular structure: ${arg.constructor?.name || 'Object'}]`;
        }
      }
      return String(arg);
    }).join(' ');

    if (logger) {
      logger.info(message);
    } else {
      originalInfo.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [BACKEND INFO] ${message}`;
      const debugLogPath = path.join(process.cwd(), 'backend-debug.log');
      const logLine = `${logMessage}\n`;

      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        originalInfo('[Main] Failed to write to backend debug log:', error);
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'info', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalInfo('[Main] Failed to send info to renderer:', e);
      }
    }
  };

  console.debug = (...args: unknown[]) => {
    const message = args.map(arg => {
      if (typeof arg === 'object' && arg !== null) {
        if (arg instanceof Error) {
          return `Error: ${arg.message}\nStack: ${arg.stack}`;
        }
        try {
          return JSON.stringify(arg, null, 2);
        } catch (e) {
          // Handle circular structure
          return `[Object with circular structure: ${arg.constructor?.name || 'Object'}]`;
        }
      }
      return String(arg);
    }).join(' ');

    // In development, also write to backend debug log file
    if (isDevelopment) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [BACKEND DEBUG] ${message}`;
      const debugLogPath = path.join(process.cwd(), 'backend-debug.log');
      const logLine = `${logMessage}\n`;

      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        console.error('[Main] Failed to write to backend debug log:', error);
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'debug', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        console.error('[Main] Failed to send debug to renderer:', e);
      }
    }
  };

  // Log any renderer errors
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('Renderer process crashed:', details);
  });

  // Handle window focus/blur/minimize for smart git status polling
  mainWindow.on('focus', () => {
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(false); // false = visible/focused
    }
    resourceMonitorService.handleVisibilityChange(false);
  });

  mainWindow.on('blur', () => {
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(true); // true = hidden/blurred
    }
    resourceMonitorService.handleVisibilityChange(true);
  });

  mainWindow.on('minimize', () => {
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(true); // true = hidden/minimized
    }
    resourceMonitorService.handleVisibilityChange(true);
  });

  mainWindow.on('restore', () => {
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(false); // false = visible/restored
    }
    resourceMonitorService.handleVisibilityChange(false);
  });
}

async function initializeServices() {
  configManager = new ConfigManager();
  await configManager.initialize();

  // Initialize logger early so it can capture all logs
  logger = new Logger(configManager);
  console.log('[Main] Logger initialized with file logging to ~/.pane/logs');
  
  // Initialize commitManager with configManager
  initializeCommitManager(configManager, logger);

  // Use the same database path as the original backend
  const dbPath = configManager.getDatabasePath();
  databaseService = new DatabaseService(dbPath);
  databaseService.initialize();

  // Initialize analytics manager early so it can be used by SessionManager
  analyticsManager = new AnalyticsManager(configManager);

  // Receive the renderer's posthog-js distinct ID so shutdown analytics use the same identity
  ipcMain.on('analytics:sync-distinct-id', async (_event: Electron.IpcMainEvent, distinctId: string) => {
    try {
      await configManager.setAnalyticsDistinctId(distinctId);
    } catch (error) {
      console.error('[Analytics] Failed to persist distinct ID:', error);
    }
  });

  // Set analytics manager on logsManager for script execution tracking
  const { logsManager } = await import('./services/panels/logPanel/logsManager');
  logsManager.setAnalyticsManager(analyticsManager);

  sessionManager = new SessionManager(databaseService, analyticsManager);
  sessionManager.initializeFromDatabase();

  archiveProgressManager = new ArchiveProgressManager();

  spotlightManager = new SpotlightManager(sessionManager, logger, () => mainWindow);

  // Start permission IPC server
  console.log('[Main] Initializing Permission IPC server...');
  permissionIpcServer = new PermissionIpcServer();
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

  // Create worktree manager with configManager and analyticsManager
  worktreeManager = new WorktreeManager(configManager, analyticsManager);

  // Initialize the active project's worktree directory if one exists
  const activeProject = sessionManager.getActiveProject();
  if (activeProject) {
    const ctx = sessionManager.getProjectContextByProjectId(activeProject.id);
    if (ctx) {
      await worktreeManager.initializeProject(activeProject.path, undefined, ctx.pathResolver, ctx.commandRunner);
    }
  }

  // Initialize CLI manager factory
  cliManagerFactory = CliManagerFactory.getInstance(logger, configManager);

  // Create default CLI manager (Claude) with permission IPC path
  // Skip validation during startup - tools will be validated when actually used
  defaultCliManager = await cliManagerFactory.createManager('claude', {
    sessionManager,
    logger,
    configManager,
    additionalOptions: { permissionIpcPath },
    skipValidation: true  // Allow Pane to start even if Claude Code is not installed
  });
  gitDiffManager = new GitDiffManager(logger, analyticsManager);
  gitStatusManager = new GitStatusManager(sessionManager, worktreeManager, gitDiffManager, logger);
  executionTracker = new ExecutionTracker(sessionManager, gitDiffManager);
  worktreeNameGenerator = new WorktreeNameGenerator(configManager);
  runCommandManager = new RunCommandManager(databaseService);

  // Initialize version checker
  versionChecker = new VersionChecker(configManager, logger);

  taskQueue = new TaskQueue({
    sessionManager,
    worktreeManager,
    claudeCodeManager: defaultCliManager, // Use default CLI manager for backward compatibility
    gitDiffManager,
    executionTracker,
    worktreeNameGenerator,
    getMainWindow: () => mainWindow
  });

  const services: AppServices = {
    app,
    configManager,
    databaseService,
    sessionManager,
    worktreeManager,
    cliManagerFactory,
    claudeCodeManager: defaultCliManager, // Backward compatibility
    gitDiffManager,
    gitStatusManager,
    executionTracker,
    worktreeNameGenerator,
    runCommandManager,
    versionChecker,
    taskQueue,
    getMainWindow: () => mainWindow,
    logger,
    archiveProgressManager,
    analyticsManager,
    spotlightManager,
  };

  // Initialize IPC handlers first so managers (like ClaudePanelManager) are ready
  registerIpcHandlers(services);
  // Then set up event listeners that may rely on initialized managers
  setupEventListeners(services, () => mainWindow);
  
  // Register console logging IPC handler for development
  if (isDevelopment) {
    ipcMain.handle('console:log', (event, logData) => {
      const { level, args, timestamp, source } = logData;
      const message = args.join(' ');
      const logLine = `[${timestamp}] [${source.toUpperCase()} ${level.toUpperCase()}] ${message}\n`;
      
      // Write to debug log file
      const debugLogPath = path.join(process.cwd(), 'frontend-debug.log');
      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        console.error('Failed to write console log to debug file:', error);
      }
      
      // Also log to main console with prefix
      console.log(`[Frontend ${level}] ${message}`);
    });
  }
  
  // Start periodic version checking (only if enabled in settings)
  versionChecker.startPeriodicCheck();
  
  // Start git status polling
  gitStatusManager.startPolling();

  // Start resource monitoring
  resourceMonitorService.initialize(app);
  resourceMonitorService.startIdlePolling();

  // Restore spotlight state from previous session
  try {
    spotlightManager.restoreAll();
  } catch (error) {
    console.error('[Main] Failed to restore spotlight state:', error);
  }
}

app.whenReady().then(async () => {
  appStartTime = Date.now();

  console.log('[Main] App is ready, initializing services...');
  await initializeServices();
  console.log('[Main] Services initialized, creating window...');
  await createWindow();
  console.log('[Main] Window created successfully');

  // Track app lifecycle events
  try {
    const currentVersion = app.getVersion();
    const lastVersion = databaseService.getLastAppVersion();
    const isFirstLaunch = lastVersion === null;

    if (lastVersion && lastVersion !== currentVersion) {
      analyticsManager.track('app_updated', {
        previous_version: lastVersion,
        new_version: currentVersion,
      });
    }

    analyticsManager.track('app_opened', {
      is_first_launch: isFirstLaunch,
    });

    databaseService.recordAppOpen(false, false, currentVersion);
  } catch (error) {
    console.error('[Main] Failed to track app lifecycle events:', error);
  }

  // Configure auto-updater
  setupAutoUpdater(() => mainWindow);

  // Check for updates after window is created
  setTimeout(async () => {
    console.log('[Main] Performing startup version check...');
    await versionChecker.checkOnStartup();
  }, 1000); // Small delay to ensure window is fully ready

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      console.log('[Main] Activating app, creating new window...');
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  // Write directly to debug log to ensure shutdown is visible even if console override fails
  const debugLogPath = path.join(process.cwd(), 'backend-debug.log');
  const logToFile = (msg: string) => {
    try {
      fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] [SHUTDOWN] ${msg}\n`);
    } catch { /* ignore */ }
  };

  logToFile('before-quit fired');

  // Guard against multiple shutdown attempts
  if (shutdownInProgress) {
    logToFile('shutdown already in progress, skipping');
    return;
  }

  // Prevent default quit behavior - we'll manually exit when ready
  event.preventDefault();
  shutdownInProgress = true;
  logToFile('shutdown started');

  // Check if there are active archive tasks (before try/finally so "Wait" can cancel quit)
  if (archiveProgressManager && archiveProgressManager.hasActiveTasks()) {
    console.log('[Main] Archive tasks in progress, showing warning dialog...');
    const activeCount = archiveProgressManager.getActiveTaskCount();
    const choice = mainWindow
      ? dialog.showMessageBoxSync(mainWindow, {
          type: 'warning',
          title: 'Archive Tasks In Progress',
          message: `Pane is removing ${activeCount} worktree${activeCount > 1 ? 's' : ''} in the background.`,
          detail: 'Git worktree removal can take time, especially for large repositories with many files. If you quit now, the worktree directories may not be fully cleaned up and you may need to remove them manually.\n\nDo you want to quit anyway?',
          buttons: ['Wait', 'Quit Anyway'],
          defaultId: 0,
          cancelId: 0
        })
      : dialog.showMessageBoxSync({
          type: 'warning',
          title: 'Archive Tasks In Progress',
          message: `Pane is removing ${activeCount} worktree${activeCount > 1 ? 's' : ''} in the background.`,
          detail: 'Git worktree removal can take time, especially for large repositories with many files. If you quit now, the worktree directories may not be fully cleaned up and you may need to remove them manually.\n\nDo you want to quit anyway?',
          buttons: ['Wait', 'Quit Anyway'],
          defaultId: 0,
          cancelId: 0
        });

    if (choice === 0) {
      // User chose to wait - reset guard and cancel quit
      shutdownInProgress = false;
      return;
    }

    // User chose to quit anyway
    archiveProgressManager.clearAll();
  }

  // Safety net: force exit if graceful shutdown takes too long
  // Placed after the dialog so user interaction time isn't counted
  const shutdownSafetyTimeout = setTimeout(() => {
    logToFile('FORCED EXIT: shutdown timed out after 10s');
    app.exit(1);
  }, 10_000);

  try {
    // Stop resource monitoring
    resourceMonitorService.stop();

    // Phase 1: Send Ctrl+C to all terminals to gracefully exit Claude instances
    // Claude needs to exit cleanly so it releases the session ID lock, allowing
    // us to resume with --resume <panelId> on next launch.
    const shutdownStartTime = Date.now();
    logToFile('Phase 1: sending Ctrl+C to all terminals');
    console.log('[Main] Graceful shutdown: sending Ctrl+C to all terminals...');
    const signaledPanels = terminalPanelManager.sendCtrlCToAll();
    logToFile(`Signaled ${signaledPanels.length} terminals: ${signaledPanels.join(', ')}`);
    if (signaledPanels.length > 0) {
      // Send a second Ctrl+C after a short delay to ensure Claude exits
      await new Promise(resolve => setTimeout(resolve, 200));
      terminalPanelManager.sendCtrlCToAll();
      logToFile('Sent second Ctrl+C, waiting 2s...');
      // Wait for Claude to fully exit and release session locks
      console.log(`[Main] Waiting for ${signaledPanels.length} terminal(s) to exit (2s)...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      logToFile('2s wait complete');
    }

    // Phase 2: Save terminal states and mark Claude terminals as interrupted
    logToFile('Phase 2: saving terminal states');
    console.log('[Main] Saving terminal states...');
    await terminalPanelManager.saveAllTerminalStates();

    const interruptedPanels = new Map<string, string[]>(); // sessionId → panelIds

    // Find all terminal panels running Claude and mark them as interrupted
    const allTerminalPanelIds = terminalPanelManager.getAllPanelIds();
    for (const panelId of allTerminalPanelIds) {
      const panel = panelManager.getPanel(panelId);
      if (!panel) continue;

      const customState = (panel.state?.customState || {}) as TerminalPanelState;
      const hadClaude = customState.initialCommand && customState.initialCommand.toLowerCase().includes('claude');

      if (hadClaude) {
        customState.wasInterrupted = true;
        panel.state.customState = customState;
        await panelManager.updatePanel(panelId, { state: panel.state });

        const existing = interruptedPanels.get(panel.sessionId);
        if (existing) {
          existing.push(panelId);
        } else {
          interruptedPanels.set(panel.sessionId, [panelId]);
        }
        logToFile(`Marked terminal panel ${panelId} as interrupted`);
        console.log(`[Main] Marked terminal panel ${panelId} as interrupted (Claude CLI, session-id = panel ID)`);
      }
    }

    logToFile(`Found ${interruptedPanels.size} session(s) with interrupted terminals`);

    console.log(`[Main] Graceful shutdown: found ${interruptedPanels.size} session(s) with interrupted terminals`);

    // Phase 3: Mark sessions as interrupted in DB
    for (const [sessionId, panelIds] of interruptedPanels) {
      if (databaseService) {
        databaseService.updateSession(sessionId, { status: 'interrupted' });
        console.log(`[Main] Marked session ${sessionId} as interrupted (${panelIds.length} panel${panelIds.length > 1 ? 's' : ''})`);
      }
    }

    console.log(`[Main] Graceful shutdown: marked ${interruptedPanels.size} session${interruptedPanels.size !== 1 ? 's' : ''} as interrupted`);

    // Kill all terminal panel PTY processes so Claude doesn't survive as an orphan
    logToFile('Destroying all terminal panel processes');
    console.log('[Main] Destroying all terminal panel processes...');
    terminalPanelManager.destroyAllTerminals();
    console.log('[Main] Terminal panel processes destroyed');

    // Phase 4: Normal cleanup (existing code)
    // Disable all spotlights and restore repo roots
    if (spotlightManager) {
      console.log('[Main] Disabling all spotlights...');
      spotlightManager.disableAll();
      console.log('[Main] Spotlights disabled');
    }

    // Cleanup all sessions and terminate child processes
    if (sessionManager) {
      console.log('[Main] Cleaning up sessions and terminating child processes...');
      await sessionManager.cleanup();
      console.log('[Main] Session cleanup complete');
    }

    // Stop all run commands
    if (runCommandManager) {
      console.log('[Main] Stopping all run commands...');
      await runCommandManager.stopAllRunCommands();
      console.log('[Main] Run commands stopped');
    }

    // Stop git status polling
    if (gitStatusManager) {
      console.log('[Main] Stopping git status polling...');
      gitStatusManager.stopPolling();
      console.log('[Main] Git status polling stopped');
    }

    // Kill IAP tunnel if running
    const cloudManager = getCloudVmManager();
    if (cloudManager) {
      console.log('[Main] Stopping cloud IAP tunnel...');
      cloudManager.stopTunnel();
      cloudManager.stopPolling();
      console.log('[Main] Cloud tunnel stopped');
    }

    // Stop config file watcher
    if (configManager) {
      configManager.stopWatching();
    }

    // Shutdown CLI manager factory and all CLI processes
    if (cliManagerFactory) {
      console.log('[Main] Shutting down CLI manager factory and all CLI processes...');
      await cliManagerFactory.shutdown();
      console.log('[Main] CLI manager factory shutdown complete');
    }

    // Close task queue
    if (taskQueue) {
      await taskQueue.close();
    }

    // Stop permission IPC server
    if (permissionIpcServer) {
      console.log('[Main] Stopping permission IPC server...');
      await permissionIpcServer.stop();
      console.log('[Main] Permission IPC server stopped');
    }

    // Stop version checker
    if (versionChecker) {
      versionChecker.stopPeriodicCheck();
    }

    // Track app closed event with session duration.
    // Send directly via HTTP instead of IPC — the renderer may already be
    // tearing down, so an IPC-forwarded event would likely be dropped.
    if (configManager && configManager.isAnalyticsEnabled() && appStartTime) {
      try {
        const settings = configManager.getAnalyticsSettings();
        const apiKey = settings.posthogApiKey || 'phc_uwOqT2KUa4C9Qx5WbEPwQSN9mUCoSGFg1aY0b670ft5';
        const host = settings.posthogHost || 'https://us.i.posthog.com';
        const distinctId = configManager.getAnalyticsDistinctId() || `anon-${Date.now().toString(36)}`;
        const sessionDurationSeconds = Math.floor((Date.now() - appStartTime) / 1000);

        const { net } = await import('electron');
        await net.fetch(`${host}/capture/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            event: 'app_closed',
            properties: {
              distinct_id: distinctId,
              token: apiKey,
              session_duration_seconds: sessionDurationSeconds,
              app_version: app.getVersion(),
              platform: os.platform(),
              $lib: 'posthog-node',
            },
            timestamp: new Date().toISOString(),
          }),
        });
      } catch (error) {
        console.error('[Analytics] Failed to track app_closed event:', error);
      }
    }

    // Close logger to ensure all logs are flushed
    if (logger) {
      logger.close();
    }

    const totalShutdownTime = Date.now() - shutdownStartTime;
    logToFile(`Graceful shutdown complete in ${Date.now() - shutdownStartTime}ms`);
    console.log(`[Main] Graceful shutdown complete in ${totalShutdownTime}ms`);

  } catch (error) {
    logToFile(`ERROR during shutdown: ${error}`);
    console.error('[Main] Error during graceful shutdown:', error);
  } finally {
    clearTimeout(shutdownSafetyTimeout);
    logToFile('Calling app.exit(0)');
    // Exit the app
    app.exit(0);
  }
});

// Export getter function for mainWindow
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
