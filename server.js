'use strict';

const os = require('os');
const path = require('path');
const { createApp } = require('./server/create-app');
const { ScanManager } = require('./server/scan-manager');

const PORT = Number(process.env.PORT || 3000);
const scannerPath = process.env.DISKSTATSX_SCANNER_PATH || path.join(__dirname, 'scanner');
const resultPath = process.env.DISKSTATSX_RESULT_PATH ||
  path.join(os.tmpdir(), 'diskstatsx-scan-index.sqlite');

const scanManager = new ScanManager({ scannerPath, resultPath });
const app = createApp({
  scanManager,
  defaultScanPath: os.homedir(),
  publicPath: path.join(__dirname, 'public'),
  vendorPath: path.join(__dirname, 'node_modules', 'd3', 'dist')
});

function startServer(port = PORT, callback) {
  return app.listen(port, '127.0.0.1', callback);
}

function stopActiveScan() {
  scanManager.dispose();
}

if (require.main === module) {
  const server = startServer(PORT, () => {
    console.log(`DiskStatsX running at http://localhost:${PORT}`);
  });
  process.on('SIGINT', () => {
    stopActiveScan();
    server.close(() => process.exit(0));
  });
}

module.exports = {
  app,
  scanManager,
  startServer,
  stopActiveScan
};
