'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { app, BrowserWindow, nativeImage } = require('electron');
const { startServer, stopActiveScan } = require('../server');

const OUTPUT_DIRECTORY = path.join(__dirname, '..', 'docs', 'screenshots');
const VIEWPORT = { width: 1280, height: 720 };

app.commandLine.appendSwitch('use-mock-keychain');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function waitForPage(window, predicate) {
  await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = () => {
        if (${predicate}) {
          resolve();
          return;
        }
        if (Date.now() - startedAt > 5000) {
          reject(new Error('Timed out waiting for screenshot view'));
          return;
        }
        requestAnimationFrame(check);
      };
      check();
    })
  `);
}

async function captureImage(window) {
  const image = await window.webContents.capturePage();
  return image.resize({
    ...VIEWPORT,
    quality: 'best'
  });
}

async function writeImage(image, fileName) {
  await fs.writeFile(path.join(OUTPUT_DIRECTORY, fileName), image.toPNG());
}

function replaceTop(baseImage, headerImage, height) {
  const size = baseImage.getSize();
  const rowBytes = size.width * 4;
  const end = Math.max(0, Math.min(size.height, height)) * rowBytes;
  const bitmap = Buffer.from(baseImage.toBitmap());
  headerImage.toBitmap().copy(bitmap, 0, 0, end);
  return nativeImage.createFromBitmap(bitmap, {
    width: size.width,
    height: size.height,
    scaleFactor: 1
  });
}

async function settleForCapture(window) {
  window.setContentSize(VIEWPORT.width + 1, VIEWPORT.height);
  await new Promise((resolve) => setTimeout(resolve, 100));
  window.setContentSize(VIEWPORT.width, VIEWPORT.height);
  window.focus();
  await new Promise((resolve) => setTimeout(resolve, 700));
}

function createCaptureWindow() {
  return new BrowserWindow({
    ...VIEWPORT,
    useContentSize: true,
    show: true,
    frame: false,
    webPreferences: {
      backgroundThrottling: false
    }
  });
}

async function run() {
  await app.whenReady();
  const server = startServer(0);
  await once(server, 'listening');
  const port = server.address().port;
  let treemapWindow = null;
  let sunburstWindow = null;

  try {
    await fs.mkdir(OUTPUT_DIRECTORY, { recursive: true });
    treemapWindow = createCaptureWindow();
    await treemapWindow.loadURL(`http://127.0.0.1:${port}/?demo=1`);
    await waitForPage(
      treemapWindow,
      "document.fonts.status === 'loaded' && Number(document.querySelector('#treemap-canvas')?.dataset.tileCount || 0) > 0"
    );
    await settleForCapture(treemapWindow);
    const treemapImage = await captureImage(treemapWindow);
    await writeImage(treemapImage, 'treemap-demo.png');
    await treemapWindow.webContents.executeJavaScript(`
      document.querySelector('#treemap-view-button').classList.remove('active');
      document.querySelector('#sunburst-view-button').classList.add('active');
    `);
    const sunburstHeaderImage = await captureImage(treemapWindow);

    sunburstWindow = createCaptureWindow();
    await sunburstWindow.loadURL(`http://127.0.0.1:${port}/?demo=1&view=sunburst`);
    await waitForPage(
      sunburstWindow,
      "document.querySelectorAll('.sunburst-arc').length > 0"
    );
    await settleForCapture(sunburstWindow);
    const visualTop = await sunburstWindow.webContents.executeJavaScript(
      "Math.round(document.querySelector('.visual-panel').getBoundingClientRect().top)"
    );
    const sunburstImage = await captureImage(sunburstWindow);
    await writeImage(
      replaceTop(sunburstImage, sunburstHeaderImage, visualTop),
      'sunburst-demo.png'
    );
  } finally {
    for (const window of [treemapWindow, sunburstWindow]) {
      if (window && !window.isDestroyed()) {
        window.destroy();
      }
    }
    stopActiveScan();
    server.close();
    server.closeAllConnections?.();
  }
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
