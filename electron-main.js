const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const { FileLogger } = require('./server/file-logger');

let server = null;
let mainWindow = null;
let logger = null;
const EXTERNAL_PROTOCOLS = new Set(['https:', 'mailto:']);
const LOGGED_SCAN_EVENTS = new Set(['started', 'done', 'canceled', 'scan-error']);

function scannerPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'scanner');
  }
  return path.join(__dirname, 'scanner');
}

function resultPath() {
  return path.join(app.getPath('userData'), 'scan-index.sqlite');
}

function initializeLogging() {
  app.setAppLogsPath();
  const logPath = path.join(app.getPath('logs'), 'diskstatsx.log');
  logger = new FileLogger(logPath);
  logger.info('application-started', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    architecture: process.arch
  });
}

function compactRendererError(payload) {
  const value = payload && typeof payload === 'object' ? payload : {};
  return {
    type: String(value.type || 'renderer-error').slice(0, 80),
    message: String(value.message || 'Unknown renderer error').slice(0, 4000),
    source: String(value.source || '').slice(0, 1000),
    line: Number(value.line || 0),
    column: Number(value.column || 0),
    stack: String(value.stack || '').slice(0, 12000)
  };
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
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    logger?.error('renderer-load-failed', {
      errorCode,
      errorDescription,
      url: validatedUrl
    });
  });
  mainWindow.on('unresponsive', () => {
    logger?.warn('renderer-unresponsive');
  });
  mainWindow.on('responsive', () => {
    logger?.info('renderer-responsive');
  });
  mainWindow.webContents.on('render-process-gone', async (_event, details) => {
    logger?.error('renderer-process-gone', details);
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'DiskStatsX renderer stopped',
      message: 'The visualization process stopped unexpectedly.',
      detail: `Diagnostics were written to:\n${logger?.filePath || app.getPath('logs')}`,
      buttons: ['Reload interface', 'Close'],
      defaultId: 0,
      cancelId: 1
    });
    if (result.response === 0 && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    } else if (!mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });
}

async function boot() {
  initializeLogging();
  process.env.DISKSTATSX_SCANNER_PATH = scannerPath();
  process.env.DISKSTATSX_RESULT_PATH = resultPath();

  const { scanManager, startServer } = require('./server');
  scanManager.on('status', (event, status) => {
    if (!LOGGED_SCAN_EVENTS.has(event)) {
      return;
    }
    const details = {
      state: status.state,
      rootPath: status.rootPath,
      filesScanned: status.filesScanned,
      directoriesScanned: status.directoriesScanned,
      bytesDiscovered: status.bytesDiscovered,
      elapsedMs: status.elapsedMs,
      error: status.error
    };
    if (event === 'done') {
      try {
        details.resultBytes = fs.statSync(resultPath()).size;
      } catch {
        details.resultBytes = null;
      }
    }
    logger.info(`scan-${event}`, details);
  });

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
  ipcMain.on('diskstatsx:renderer-error', (_event, payload) => {
    logger?.error('renderer-javascript-error', compactRendererError(payload));
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
  logger?.info('application-stopping');
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

app.on('child-process-gone', (_event, details) => {
  logger?.error('child-process-gone', details);
});
