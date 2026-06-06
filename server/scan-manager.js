'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_QUERY_OUTPUT_BYTES = 32 * 1024 * 1024;

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
    this.resultBytes = 0;
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
      resultReady: this.resultReady,
      resultBytes: this.resultBytes
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
    const scannerArgs = this.scannerArguments(rootPath, filters);

    this.process = spawn(this.scannerPath, scannerArgs, {
      cwd: path.dirname(this.scannerPath),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    const child = this.process;

    child.stderr.on('data', (chunk) => this.consumeProgress(chunk.toString('utf8')));
    child.on('error', (error) => {
      this.finishedAt = Date.now();
      if (this.process === child) {
        this.process = null;
      }
      this.publish('scan-error', { state: 'error', error: error.message });
    });
    child.on('close', (code, signal) => {
      this.handleClose({ child, code, signal });
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
    const args = [rootPath, '--database', this.resultPath];
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
    fs.rmSync(`${this.resultPath}-shm`, { force: true });
    fs.rmSync(`${this.resultPath}-wal`, { force: true });
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.stderrBuffer = '';
    this.resultReady = false;
    this.resultBytes = 0;
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
    this.emit('status', event, this.snapshot);
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

  handleClose({ child, code, signal }) {
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

    if (wasCanceled) {
      this.resultReady = false;
      this.resultBytes = 0;
      fs.rmSync(this.resultPath, { force: true });
      this.publish('canceled', { state: 'canceled', error: null });
    } else if (code === 0) {
      try {
        this.resultBytes = fs.statSync(this.resultPath).size;
      } catch (error) {
        this.resultReady = false;
        this.publish('scan-error', {
          state: 'error',
          error: `could not finalize scan index: ${error.message}`
        });
        return;
      }
      this.resultReady = true;
      this.publish('done', { state: 'done', error: null });
    } else {
      this.resultReady = false;
      this.resultBytes = 0;
      fs.rmSync(this.resultPath, { force: true });
      const error = signal
        ? `scanner terminated by ${signal}`
        : `scanner exited with code ${code}`;
      this.publish('scan-error', { state: 'error', error });
    }
  }

  readDirectory(requestedPath) {
    if (!this.canServeResult) {
      throw createHttpError(this.isRunning ? 202 : 404, 'no scan result available');
    }
    const targetPath = requestedPath || this.status.rootPath;
    return new Promise((resolve, reject) => {
      const query = spawn(this.scannerPath, ['--query', this.resultPath, targetPath], {
        cwd: path.dirname(this.scannerPath),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const output = [];
      const errors = [];
      let outputBytes = 0;
      let rejected = false;

      query.stdout.on('data', (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_QUERY_OUTPUT_BYTES) {
          rejected = true;
          query.kill('SIGTERM');
          reject(createHttpError(413, 'directory view is too large'));
          return;
        }
        output.push(chunk);
      });
      query.stderr.on('data', (chunk) => errors.push(chunk));
      query.on('error', (error) => {
        if (!rejected) {
          reject(error);
        }
      });
      query.on('close', (code) => {
        if (rejected) {
          return;
        }
        if (code !== 0) {
          const message = Buffer.concat(errors).toString('utf8').trim();
          reject(createHttpError(404, message || 'directory is not available'));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(output).toString('utf8')));
        } catch {
          reject(createHttpError(500, 'scanner returned an invalid directory view'));
        }
      });
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
