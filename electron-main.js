const path = require('path');
const { URL } = require('url');
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');

let server = null;
let mainWindow = null;
const EXTERNAL_PROTOCOLS = new Set(['https:', 'mailto:']);

function scannerPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'scanner');
  }
  return path.join(__dirname, 'scanner');
}

function resultPath() {
  return path.join(app.getPath('userData'), 'scan-result.json');
}

function openExternalUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    if (EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
      shell.openExternal(parsed.toString());
    }
  } catch {
    // Ignore malformed or unsupported external URLs.
  }
}

function createWindow(url) {
  const appOrigin = new URL(url).origin;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'DiskStatsX',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 20 },
    backgroundColor: '#0b0f12',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadURL(url);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    openExternalUrl(targetUrl);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (new URL(targetUrl).origin !== appOrigin) {
      event.preventDefault();
      openExternalUrl(targetUrl);
    }
  });
}

async function boot() {
  process.env.DISKSTATSX_SCANNER_PATH = scannerPath();
  process.env.DISKSTATSX_RESULT_PATH = resultPath();

  const { startServer } = require('./server');

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  ipcMain.handle('diskstatsx:select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder to analyze',
      buttonLabel: 'Choose Folder',
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  await new Promise((resolve, reject) => {
    server = startServer(0);
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address();
  createWindow(`http://127.0.0.1:${address.port}`);
}

app.whenReady()
  .then(boot)
  .catch((error) => {
    dialog.showErrorBox('DiskStatsX failed to start', error.stack || error.message);
    app.quit();
  });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && server) {
    const address = server.address();
    createWindow(`http://127.0.0.1:${address.port}`);
  }
});

app.on('before-quit', () => {
  try {
    const { stopActiveScan } = require('./server');
    stopActiveScan();
  } catch {
    // App is already quitting; nothing useful to report here.
  }
  if (server) {
    server.close();
    server = null;
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
