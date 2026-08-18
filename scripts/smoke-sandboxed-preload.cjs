const path = require('path');
process.env.NODE_ENV = 'production';
const { app, BrowserWindow } = require('electron');

const preloadPath = path.resolve(__dirname, '..', 'main', 'dist', 'main', 'src', 'preload.js');
const timeout = setTimeout(() => {
  console.error('Sandboxed preload smoke test timed out');
  app.exit(1);
}, 15_000);

async function run() {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

  if (preloadFailure) {
    throw preloadFailure;
  }
  if (!apiAvailable) {
    throw new Error('Sandboxed preload did not expose window.electronAPI');
  }

  console.log('Sandboxed preload smoke test passed');
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
