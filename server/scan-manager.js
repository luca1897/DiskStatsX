'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const INITIAL_STATUS = {
  state: 'idle',
  currentPath: '',
  filesScanned: 0,
  directoriesScanned: 0,
  bytesDiscovered: 0,
  elapsedMs: 0,
  error: null
};

class ScanManager extends EventEmitter {
  constructor({ scannerPath, resultPath }) {
    super();
    this.scannerPath = scannerPath;
    this.resultPath = resultPath;
    this.process = null;
    this.startedAt = null;
    this.finishedAt = null;
    this.stderrBuffer = '';
    this.resultReady = false;
    this.cancelRequested = false;
    this.status = { ...INITIAL_STATUS };
    this.heartbeat = setInterval(() => {
      if (this.process) {
        this.publish('progress');
      }
    }, 1000);
    this.heartbeat.unref?.();
  }

  get isRunning() {
    return Boolean(this.process);
  }

  get snapshot() {
    return {
      ...this.status,
      elapsedMs: this.elapsedMs(),
      resultReady: this.resultReady
    };
  }

  get canServeResult() {
    return this.resultReady && fs.existsSync(this.resultPath);
  }

  start(rootPath, filters) {
    if (this.process) {
      throw createHttpError(409, 'scan already running');
    }
    if (!rootPath) {
      throw createHttpError(400, 'path is required');
    }
    if (!this.scannerExists()) {
      throw createHttpError(500, 'scanner executable is missing; run make first');
    }

    this.reset(rootPath, filters);
    const resultStream = fs.createWriteStream(this.resultPath, { flags: 'w' });
    let outputFailed = false;
    const scannerArgs = this.scannerArguments(rootPath, filters);

    this.process = spawn(this.scannerPath, scannerArgs, {
      cwd: path.dirname(this.scannerPath),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const child = this.process;
    child.stdout.pipe(resultStream, { end: false });

    resultStream.on('error', (error) => {
      outputFailed = true;
      child.kill('SIGTERM');
      this.publish('scan-error', { state: 'error', error: error.message });
    });

    child.stderr.on('data', (chunk) => this.consumeProgress(chunk.toString('utf8')));
    child.on('error', (error) => {
      this.finishedAt = Date.now();
      if (this.process === child) {
        this.process = null;
      }
      this.publish('scan-error', { state: 'error', error: error.message });
    });
    child.on('close', (code, signal) => {
      this.handleClose({ child, resultStream, outputFailed, code, signal });
    });

    this.publish('started');
    return this.status;
  }

  cancel() {
    if (!this.process) {
      throw createHttpError(409, 'no scan is running');
    }
    this.cancelRequested = true;
    this.publish('canceling', { state: 'canceling', error: null });
    this.process.kill('SIGTERM');
  }

  stop() {
    if (this.process) {
      this.cancelRequested = true;
      this.process.kill('SIGTERM');
    }
  }

  dispose() {
    clearInterval(this.heartbeat);
    this.stop();
  }

  scannerExists() {
    try {
      fs.accessSync(this.scannerPath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  scannerArguments(rootPath, filters) {
    const args = [rootPath];
    if (filters.caches) {
      args.push('--skip-caches');
    }
    if (filters.externalVolumes) {
      args.push('--skip-external-volumes');
    }
    if (filters.systemFolders) {
      args.push('--skip-system-folders');
    }
    return args;
  }

  reset(rootPath, filters) {
    fs.rmSync(this.resultPath, { force: true });
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.stderrBuffer = '';
    this.resultReady = false;
    this.cancelRequested = false;
    this.status = {
      ...INITIAL_STATUS,
      state: 'running',
      rootPath,
      filters,
      currentPath: rootPath
    };
  }

  elapsedMs() {
    if (!this.startedAt) {
      return 0;
    }
    return (this.finishedAt || Date.now()) - this.startedAt;
  }

  publish(event, patch = {}) {
    this.status = {
      ...this.status,
      ...patch,
      elapsedMs: this.elapsedMs()
    };
    this.emit('status', event, this.status);
  }

  consumeProgress(chunk) {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() || '';
    for (const line of lines) {
      this.parseProgressLine(line);
    }
  }

  parseProgressLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') {
      return;
    }
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (payload.error) {
      this.publish('scan-error', { state: 'error', error: payload.error });
      return;
    }
    this.publish('progress', {
      currentPath: payload.currentPath || this.status.currentPath,
      filesScanned: Number(payload.filesScanned || 0),
      directoriesScanned: Number(payload.directoriesScanned || 0),
      bytesDiscovered: Number(payload.bytesDiscovered || 0),
      error: null
    });
  }

  handleClose({ child, resultStream, outputFailed, code, signal }) {
    const wasCanceled = this.cancelRequested;
    this.cancelRequested = false;
    this.finishedAt = Date.now();
    if (this.process === child) {
      this.process = null;
    }
    if (this.stderrBuffer) {
      this.parseProgressLine(this.stderrBuffer);
      this.stderrBuffer = '';
    }

    resultStream.end(() => {
      if (outputFailed) {
        return;
      }
      if (wasCanceled) {
        this.resultReady = false;
        fs.rmSync(this.resultPath, { force: true });
        this.publish('canceled', { state: 'canceled', error: null });
      } else if (code === 0) {
        this.resultReady = true;
        this.publish('done', { state: 'done', error: null });
      } else {
        this.resultReady = false;
        fs.rmSync(this.resultPath, { force: true });
        const error = signal
          ? `scanner terminated by ${signal}`
          : `scanner exited with code ${code}`;
        this.publish('scan-error', { state: 'error', error });
      }
    });
  }
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  ScanManager,
  createHttpError
};
