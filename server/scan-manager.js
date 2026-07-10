'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { HistoryStore } = require('./history-store');

const MAX_QUERY_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_SEARCH_OUTPUT_BYTES = 8 * 1024 * 1024;

const INITIAL_STATUS = {
  state: 'idle',
  phase: 'idle',
  currentPath: '',
  filesScanned: 0,
  directoriesScanned: 0,
  bytesDiscovered: 0,
  logicalBytesDiscovered: 0,
  cloudOnlyFiles: 0,
  symlinksSkipped: 0,
  unreadableDirectories: 0,
  excludedDirectories: 0,
  hardlinkDuplicates: 0,
  hardlinkBytesSaved: 0,
  cloneDuplicates: 0,
  cloneBytesSaved: 0,
  sharedBlockFiles: 0,
  elapsedMs: 0,
  error: null
};

class ScanManager extends EventEmitter {
  constructor({ scannerPath, resultPath, historyPath, historyLimit = 12 }) {
    super();
    this.scannerPath = scannerPath;
    this.workingPath = resultPath;
    this.history = new HistoryStore(
      historyPath || path.join(path.dirname(resultPath), 'history'),
      { limit: historyLimit }
    );
    this.process = null;
    this.queryProcesses = new Set();
    this.startedAt = null;
    this.finishedAt = null;
    this.stderrBuffer = '';
    this.resultReady = false;
    this.resultBytes = 0;
    this.cancelRequested = false;
    this.activeSnapshot = null;
    this.activeResultPath = null;
    this.status = { ...INITIAL_STATUS };
    this.restoreLatestSnapshot();
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
      resultBytes: this.resultBytes,
      snapshotId: this.activeSnapshot?.id || null,
      historyCount: this.history.list().length
    };
  }

  get canServeResult() {
    return this.resultReady && Boolean(this.activeResultPath) && fs.existsSync(this.activeResultPath);
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

    this.cancelQueries();
    this.reset(rootPath, filters);
    this.process = spawn(this.scannerPath, this.scannerArguments(rootPath, filters), {
      cwd: path.dirname(this.scannerPath),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    const child = this.process;
    child.stderr.on('data', (chunk) => this.consumeProgress(chunk.toString('utf8')));
    child.on('error', (error) => {
      if (this.process !== child) {
        return;
      }
      this.finishedAt = Date.now();
      this.process = null;
      this.resultReady = false;
      this.resultBytes = 0;
      removeDatabase(this.workingPath);
      this.publish('scan-error', { state: 'error', phase: 'error', error: error.message });
    });
    child.on('close', (code, signal) => this.handleClose({ child, code, signal }));

    this.publish('started');
    return this.snapshot;
  }

  cancel() {
    if (!this.process) {
      throw createHttpError(409, 'no scan is running');
    }
    this.cancelRequested = true;
    this.publish('canceling', { state: 'canceling', phase: 'canceling', error: null });
    this.process.kill('SIGTERM');
  }

  stop() {
    if (this.process) {
      this.cancelRequested = true;
      this.process.kill('SIGTERM');
    }
    this.cancelQueries();
  }

  dispose() {
    clearInterval(this.heartbeat);
    this.stop();
  }

  listHistory() {
    return this.history.list().map((record) => ({
      ...record,
      active: record.id === this.activeSnapshot?.id
    }));
  }

  activateHistory(id) {
    if (this.process) {
      throw createHttpError(409, 'cannot switch snapshots while scanning');
    }
    const record = this.history.find(id);
    const databasePath = this.history.databasePath(record);
    if (!record || !databasePath) {
      throw createHttpError(404, 'scan snapshot is not available');
    }
    this.cancelQueries();
    this.activateRecord(record, databasePath);
    this.publish('history-activated', { state: 'done', error: null });
    return this.snapshot;
  }

  readDirectory(requestedPath, { signal } = {}) {
    this.requireResult();
    const targetPath = requestedPath || this.status.rootPath;
    return this.runScannerJson(
      ['--query', this.activeResultPath, targetPath],
      MAX_QUERY_OUTPUT_BYTES,
      { signal }
    );
  }

  search(options = {}, { signal } = {}) {
    this.requireResult();
    const args = ['--search', this.activeResultPath, String(options.term || '')];
    appendSearchOption(args, '--extension', options.extension);
    appendSearchOption(args, '--min-size', options.minSize);
    appendSearchOption(args, '--max-size', options.maxSize);
    appendSearchOption(args, '--modified-after', options.modifiedAfter);
    appendSearchOption(args, '--modified-before', options.modifiedBefore);
    if (options.cloudOnly === true) {
      args.push('--cloud-only');
    }
    if (options.sharedBlocks === true) {
      args.push('--shared-blocks');
    }
    appendSearchOption(args, '--limit', Math.min(500, Math.max(1, Number(options.limit) || 200)));
    return this.runScannerJson(args, MAX_SEARCH_OUTPUT_BYTES, { signal });
  }

  cleanup(options = {}, { signal } = {}) {
    this.requireResult();
    const args = ['--cleanup', this.activeResultPath];
    appendSearchOption(args, '--older-than-days', Math.max(0, Number(options.olderThanDays) || 30));
    appendSearchOption(args, '--limit', Math.min(300, Math.max(1, Number(options.limit) || 150)));
    return this.runScannerJson(args, MAX_SEARCH_OUTPUT_BYTES, { signal });
  }

  compare(beforeId, afterId, { signal } = {}) {
    const before = this.history.find(beforeId);
    const after = this.history.find(afterId);
    const beforePath = this.history.databasePath(before);
    const afterPath = this.history.databasePath(after);
    if (!before || !after || !beforePath || !afterPath) {
      throw createHttpError(404, 'one or both scan snapshots are not available');
    }
    if (before.rootPath !== after.rootPath) {
      throw createHttpError(400, 'choose snapshots of the same root folder');
    }
    return this.runScannerJson(
      ['--compare', beforePath, afterPath],
      MAX_SEARCH_OUTPUT_BYTES,
      { signal }
    );
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
    const args = [rootPath, '--database', this.workingPath];
    if (filters.caches) {
      args.push('--skip-caches');
    }
    if (filters.externalVolumes) {
      args.push('--skip-external-volumes');
    }
    if (filters.systemFolders) {
      args.push('--skip-system-folders');
    }
    for (const excludedPath of filters.exclusions || []) {
      args.push('--exclude', excludedPath);
    }
    return args;
  }

  reset(rootPath, filters) {
    removeDatabase(this.workingPath);
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.stderrBuffer = '';
    this.resultReady = false;
    this.resultBytes = 0;
    this.cancelRequested = false;
    this.status = {
      ...INITIAL_STATUS,
      state: 'running',
      phase: 'scanning',
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
      this.publish('scan-error', { state: 'error', phase: 'error', error: payload.error });
      return;
    }
    this.publish('progress', {
      phase: payload.phase || this.status.phase,
      currentPath: payload.currentPath || this.status.currentPath,
      filesScanned: Number(payload.filesScanned || 0),
      directoriesScanned: Number(payload.directoriesScanned || 0),
      bytesDiscovered: Number(payload.bytesDiscovered || 0),
      logicalBytesDiscovered: Number(payload.logicalBytesDiscovered || 0),
      cloudOnlyFiles: Number(payload.cloudOnlyFiles || 0),
      symlinksSkipped: Number(payload.symlinksSkipped || 0),
      unreadableDirectories: Number(payload.unreadableDirectories || 0),
      excludedDirectories: Number(payload.excludedDirectories || 0),
      hardlinkDuplicates: Number(payload.hardlinkDuplicates || 0),
      hardlinkBytesSaved: Number(payload.hardlinkBytesSaved || 0),
      cloneDuplicates: Number(payload.cloneDuplicates || 0),
      cloneBytesSaved: Number(payload.cloneBytesSaved || 0),
      sharedBlockFiles: Number(payload.sharedBlockFiles || 0),
      error: null
    });
  }

  handleClose({ child, code, signal }) {
    if (this.process !== child) {
      return;
    }
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
      removeDatabase(this.workingPath);
      this.publish('canceled', { state: 'canceled', phase: 'canceled', error: null });
      return;
    }
    if (code !== 0) {
      this.resultReady = false;
      this.resultBytes = 0;
      removeDatabase(this.workingPath);
      const error = signal
        ? `scanner terminated by ${signal}`
        : `scanner exited with code ${code}`;
      this.publish('scan-error', { state: 'error', phase: 'error', error });
      return;
    }

    try {
      const resultBytes = fs.statSync(this.workingPath).size;
      const record = this.history.add(this.workingPath, this.snapshot, resultBytes);
      this.activateRecord(record, record.databasePath);
      this.publish('done', { state: 'done', phase: 'done', error: null });
    } catch (error) {
      this.resultReady = false;
      this.resultBytes = 0;
      removeDatabase(this.workingPath);
      this.publish('scan-error', {
        state: 'error',
        phase: 'error',
        error: `could not persist scan snapshot: ${error.message}`
      });
    }
  }

  restoreLatestSnapshot() {
    const latest = this.history.latest();
    const databasePath = this.history.databasePath(latest);
    if (latest && databasePath) {
      this.activateRecord(latest, databasePath);
    }
  }

  activateRecord(record, databasePath) {
    this.activeSnapshot = record;
    this.activeResultPath = databasePath;
    this.resultReady = true;
    this.resultBytes = Number(record.resultBytes || fs.statSync(databasePath).size || 0);
    const finishedAt = Date.parse(record.createdAt) || Date.now();
    this.finishedAt = finishedAt;
    this.startedAt = finishedAt - Number(record.elapsedMs || 0);
    this.status = {
      ...INITIAL_STATUS,
      state: 'done',
      phase: 'done',
      rootPath: record.rootPath,
      currentPath: record.rootPath,
      filters: record.filters || {},
      filesScanned: Number(record.filesScanned || 0),
      directoriesScanned: Number(record.directoriesScanned || 0),
      bytesDiscovered: Number(record.allocatedBytes || 0),
      logicalBytesDiscovered: Number(record.logicalBytes || 0),
      ...(record.scanSummary || {}),
      elapsedMs: Number(record.elapsedMs || 0),
      error: null
    };
  }

  requireResult() {
    if (!this.canServeResult) {
      throw createHttpError(this.isRunning ? 202 : 404, 'no scan result available');
    }
  }

  cancelQueries() {
    for (const query of this.queryProcesses) {
      query.kill('SIGTERM');
    }
  }

  runScannerJson(args, maxBytes, { signal } = {}) {
    if (signal?.aborted) {
      return Promise.reject(createHttpError(499, 'native query canceled'));
    }
    return new Promise((resolve, reject) => {
      const query = spawn(this.scannerPath, args, {
        cwd: path.dirname(this.scannerPath),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.queryProcesses.add(query);
      const output = [];
      const errors = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener('abort', abortQuery);
        this.queryProcesses.delete(query);
        callback(value);
      };
      const abortQuery = () => {
        query.kill('SIGTERM');
        finish(reject, createHttpError(499, 'native query canceled'));
      };
      signal?.addEventListener('abort', abortQuery, { once: true });
      if (signal?.aborted) {
        abortQuery();
        return;
      }
      query.stdout.on('data', (chunk) => {
        if (settled) {
          return;
        }
        outputBytes += chunk.length;
        if (outputBytes > maxBytes) {
          query.kill('SIGTERM');
          finish(reject, createHttpError(413, 'native query output is too large'));
          return;
        }
        output.push(chunk);
      });
      query.stderr.on('data', (chunk) => {
        if (!settled) {
          errors.push(chunk);
        }
      });
      query.on('error', (error) => {
        finish(reject, error);
      });
      query.on('close', (code) => {
        if (settled) {
          return;
        }
        if (code !== 0) {
          const message = Buffer.concat(errors).toString('utf8').trim();
          finish(reject, createHttpError(404, message || 'native query failed'));
          return;
        }
        try {
          finish(resolve, JSON.parse(Buffer.concat(output).toString('utf8')));
        } catch {
          finish(reject, createHttpError(500, 'scanner returned invalid JSON'));
        }
      });
    });
  }
}

function appendSearchOption(args, flag, value) {
  if (value === undefined || value === null || value === '') {
    return;
  }
  args.push(flag, String(value));
}

function removeDatabase(databasePath) {
  fs.rmSync(databasePath, { force: true });
  fs.rmSync(`${databasePath}-shm`, { force: true });
  fs.rmSync(`${databasePath}-wal`, { force: true });
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
