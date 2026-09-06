const path = require('path');
process.env.NODE_ENV = 'production';
const { app, BrowserWindow, ipcMain } = require('electron');
// This smoke test runs after build:main and compares both compiled artifacts.
const daemonContractPath = path.resolve(__dirname, '..', 'main', 'dist', 'shared', 'types', 'daemon.js');
const {
  DAEMON_OWNED_CHANNEL_PREFIXES,
  DAEMON_OWNED_EXACT_CHANNELS,
  ELECTRON_ADAPTER_ONLY_CHANNELS,
} = require(daemonContractPath);

const preloadPath = path.resolve(__dirname, '..', 'main', 'dist', 'main', 'src', 'preload.js');
const defaultAppearance = {
  appearanceMode: 'system',
  theme: 'light-rounded',
  systemLightTheme: 'light-rounded',
  systemDarkTheme: 'dark',
};
const encodedAppearance = Buffer.from(JSON.stringify(defaultAppearance), 'utf8').toString('base64url');
const timeout = setTimeout(() => {
  console.error('Sandboxed preload smoke test timed out');
  app.exit(1);
}, 15_000);

async function run() {
  const daemonChannels = [
    ...DAEMON_OWNED_CHANNEL_PREFIXES.map(prefix => `${prefix}routing-probe`),
    ...DAEMON_OWNED_EXACT_CHANNELS,
    'sessions:set-active-session',
  ];
  const electronChannels = [...ELECTRON_ADAPTER_ONLY_CHANNELS, 'routing-probe:local'];
  ipcMain.handle('daemon:invoke', (_event, channel, ...args) => ({ route: 'daemon', channel, args }));
  for (const channel of electronChannels) {
    ipcMain.handle(channel, (_event, ...args) => ({ route: 'electron', channel, args }));
  }
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--pane-appearance=${encodedAppearance}`],
    },
  });
  let preloadFailure = null;
  window.webContents.on('preload-error', (_event, _preload, error) => {
    preloadFailure = error;
  });

  await window.loadURL('data:text/html,<html><body>preload-smoke</body></html>');
  const apiAvailable = await window.webContents.executeJavaScript(
    'typeof window.electronAPI === "object" && typeof window.electronAPI.getAppVersion === "function"',
  );
  const appearanceSnapshotAvailable = await window.webContents.executeJavaScript(
    'typeof window.electronAPI.appearanceSnapshot === "object"',
  );

  if (preloadFailure) {
    throw preloadFailure;
  }
  if (!apiAvailable) {
    throw new Error('Sandboxed preload did not expose window.electronAPI');
  }
  if (!appearanceSnapshotAvailable) {
    throw new Error('Sandboxed preload did not decode the appearance snapshot');
  }

  const cases = [
    ...daemonChannels.map(channel => ({ route: 'daemon', channel, args: ['probe', null] })),
    ...electronChannels.map(channel => ({ route: 'electron', channel, args: ['probe', null] })),
  ];
  const routed = await window.webContents.executeJavaScript(
    `Promise.all(${JSON.stringify(cases)}.map(({ channel, args }) => window.electronAPI.invoke(channel, ...args)))`,
  );
  if (JSON.stringify(routed) !== JSON.stringify(cases)) {
    throw new Error('Sandboxed preload changed channel ownership or invoke arguments');
  }

  console.log(`Sandboxed preload smoke test passed (${cases.length} routing cases)`);
  window.destroy();
}

app.whenReady()
  .then(run)
  .then(() => {
    clearTimeout(timeout);
    app.quit();
  })
  .catch((error) => {
    clearTimeout(timeout);
    console.error(error);
    app.exit(1);
  });
