import { app } from 'electron';
import { createPaneDaemonHost, type PaneDaemonHost } from './bootstrap';
import {
  applyAppDirectoryOverrideFromArgs,
  getAppDirectory,
  migrateDataDirectory,
} from '../utils/appDirectory';
import { setupConsoleWrapper } from '../utils/consoleWrapper';

let daemonHost: PaneDaemonHost | null = null;
let shutdownInProgress = false;
let startupRegistered = false;

async function shutdown(exitCode: number): Promise<void> {
  if (shutdownInProgress) {
    return;
  }

  shutdownInProgress = true;
  try {
    await daemonHost?.shutdown();
  } finally {
    process.exit(exitCode);
  }
}

export function startHeadlessPaneProcess(): void {
  if (startupRegistered) {
    return;
  }

  startupRegistered = true;

  const overrideDir = applyAppDirectoryOverrideFromArgs();
  if (overrideDir) {
    console.log(`[Pane daemon] Using custom Pane directory: ${overrideDir}`);
  }

  migrateDataDirectory();
  setupConsoleWrapper();

  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  app.whenReady().then(async () => {
    daemonHost = await createPaneDaemonHost({
      app,
      getMainWindow: () => null,
      getPtyHostRuntime: () => null,
      mode: 'headless',
      restoreSpotlights: false,
    });

    const endpoint = daemonHost.paneDaemonServer?.getEndpoint();
    if (endpoint) {
      console.log(`[Pane daemon] Headless host ready on ${endpoint.transport}:${endpoint.path}`);
    } else {
      console.log(`[Pane daemon] Headless host ready in ${getAppDirectory()} (local daemon endpoint unavailable)`);
    }
  }).catch(async (error) => {
    console.error('[Pane daemon] Failed to start headless host:', error);
    await shutdown(1);
  });

  process.on('SIGINT', () => {
    void shutdown(0);
  });

  process.on('SIGTERM', () => {
    void shutdown(0);
  });
}
