'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_FILE = 'history.json';
const SETTINGS_FILE = 'history-settings.json';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_MAX_BYTES = 256 * 1024 * 1024;
const MAX_MAX_BYTES = 1024 * 1024 * 1024 * 1024;
const DEFAULT_POLICY = Object.freeze({
  maxSnapshots: 12,
  maxBytes: DEFAULT_MAX_BYTES,
  preserveLatestPerRoot: true
});

class HistoryStore {
  constructor(directory, {
    limit = DEFAULT_POLICY.maxSnapshots,
    maxBytes = DEFAULT_POLICY.maxBytes,
    preserveLatestPerRoot = DEFAULT_POLICY.preserveLatestPerRoot
  } = {}) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.manifestPath = path.join(directory, MANIFEST_FILE);
    this.settingsPath = path.join(directory, SETTINGS_FILE);
    this.defaultPolicy = normalizePolicy({
      maxSnapshots: limit,
      maxBytes,
      preserveLatestPerRoot
    });
    this.policyConfigured = fs.existsSync(this.settingsPath);
    this.policy = this.loadPolicy();
    this.records = this.load();
  }

  list() {
    return this.records.map((record) => ({
      ...record,
      resultBytes: this.recordBytes(record)
    }));
  }

  latest() {
    return this.records[0] || null;
  }

  find(id) {
    return this.records.find((record) => record.id === id) || null;
  }

  add(workingPath, status, resultBytes) {
    const createdAt = new Date().toISOString();
    const id = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    const databaseFile = `${id}.sqlite`;
    const databasePath = path.join(this.directory, databaseFile);
    fs.renameSync(workingPath, databasePath);
    removeSidecars(workingPath);

    const record = {
      id,
      databaseFile,
      createdAt,
      rootPath: status.rootPath,
      filters: status.filters || {},
      allocatedBytes: Number(status.bytesDiscovered || 0),
      logicalBytes: Number(status.logicalBytesDiscovered || 0),
      filesScanned: Number(status.filesScanned || 0),
      directoriesScanned: Number(status.directoriesScanned || 0),
      elapsedMs: Number(status.elapsedMs || 0),
      resultBytes: Number(resultBytes || 0),
      scanSummary: compactSummary(status)
    };
    this.records.unshift(record);
    this.prune();
    this.save();
    return { ...record, databasePath };
  }

  databasePath(record) {
    if (!record || !safeFileName(record.databaseFile)) {
      return null;
    }
    const candidate = path.join(this.directory, record.databaseFile);
    return fs.existsSync(candidate) ? candidate : null;
  }

  protectedIds(extraIds = []) {
    const protectedIds = new Set(extraIds.filter(Boolean));
    if (this.records[0]) {
      protectedIds.add(this.records[0].id);
    }
    if (this.policy.preserveLatestPerRoot) {
      const roots = new Set();
      for (const record of this.records) {
        const rootPath = normalizeRootPath(record.rootPath);
        if (!roots.has(rootPath)) {
          roots.add(rootPath);
          protectedIds.add(record.id);
        }
      }
    }
    return protectedIds;
  }

  summary(extraProtectedIds = []) {
    const protectedIds = this.protectedIds(extraProtectedIds);
    const activeIds = new Set(extraProtectedIds.filter(Boolean));
    let totalBytes = 0;
    let protectedBytes = 0;
    let clearableBytes = 0;
    for (const record of this.records) {
      const bytes = this.recordBytes(record);
      totalBytes += bytes;
      if (protectedIds.has(record.id)) {
        protectedBytes += bytes;
      }
      if (!activeIds.has(record.id)) {
        clearableBytes += bytes;
      }
    }
    return {
      snapshotCount: this.records.length,
      totalBytes,
      protectedCount: protectedIds.size,
      protectedBytes,
      clearableBytes,
      overLimitBytes: Math.max(0, totalBytes - this.policy.maxBytes),
      limitsSatisfied: this.records.length <= this.policy.maxSnapshots &&
        totalBytes <= this.policy.maxBytes,
      policyConfigured: this.policyConfigured,
      policy: { ...this.policy }
    };
  }

  updatePolicy(policy, { protectedIds = [] } = {}) {
    this.policy = normalizePolicy(policy, this.policy);
    this.policyConfigured = true;
    this.savePolicy();
    const removed = this.prune({ protectedIds });
    return { removed, summary: this.summary(protectedIds) };
  }

  remove(id) {
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) {
      return null;
    }
    const [record] = this.records.splice(index, 1);
    const bytes = this.recordBytes(record);
    this.removeDatabase(record);
    this.save();
    return { ...record, resultBytes: bytes };
  }

  clear({ exceptIds = [] } = {}) {
    const retainedIds = new Set(exceptIds.filter(Boolean));
    const removed = [];
    const retained = [];
    for (const record of this.records) {
      if (retainedIds.has(record.id)) {
        retained.push(record);
        continue;
      }
      removed.push({ ...record, resultBytes: this.recordBytes(record) });
      this.removeDatabase(record);
    }
    this.records = retained;
    this.save();
    return removed;
  }

  prune({ protectedIds = [] } = {}) {
    const retainedIds = this.protectedIds(protectedIds);
    const removed = [];
    let totalBytes = this.totalBytes();
    for (let index = this.records.length - 1; index >= 0; index--) {
      const overCount = this.records.length > this.policy.maxSnapshots;
      const overBytes = totalBytes > this.policy.maxBytes;
      if (!overCount && !overBytes) {
        break;
      }
      const record = this.records[index];
      if (retainedIds.has(record.id)) {
        continue;
      }
      const bytes = this.recordBytes(record);
      this.records.splice(index, 1);
      this.removeDatabase(record);
      totalBytes -= bytes;
      removed.push({ ...record, resultBytes: bytes });
    }
    if (removed.length > 0) {
      this.save();
    }
    return removed;
  }

  totalBytes() {
    return this.records.reduce((total, record) => total + this.recordBytes(record), 0);
  }

  recordBytes(record) {
    const databasePath = this.databasePath(record);
    if (!databasePath) {
      return 0;
    }
    return databaseFiles(databasePath)
      .reduce((total, filePath) => total + fileSize(filePath), 0);
  }

  removeDatabase(record) {
    const databasePath = record && safeFileName(record.databaseFile)
      ? path.join(this.directory, record.databaseFile)
      : null;
    if (!databasePath) {
      return;
    }
    fs.rmSync(databasePath, { force: true });
    removeSidecars(databasePath);
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
      if (!Array.isArray(parsed)) {
        return [];
      }
      const records = parsed
        .filter(isValidRecord)
        .filter((record) => fs.existsSync(path.join(this.directory, record.databaseFile)))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      if (records.length !== parsed.length) {
        this.records = records;
        this.save();
      }
      return records;
    } catch {
      return [];
    }
  }

  loadPolicy() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      return normalizePolicy(parsed, this.defaultPolicy);
    } catch {
      return { ...this.defaultPolicy };
    }
  }

  save() {
    writeJsonAtomic(this.manifestPath, this.records);
  }

  savePolicy() {
    writeJsonAtomic(this.settingsPath, this.policy);
  }
}

function normalizePolicy(value, fallback = DEFAULT_POLICY) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    maxSnapshots: clampInteger(source.maxSnapshots, 1, 100, fallback.maxSnapshots),
    maxBytes: clampInteger(source.maxBytes, MIN_MAX_BYTES, MAX_MAX_BYTES, fallback.maxBytes),
    preserveLatestPerRoot: source.preserveLatestPerRoot === undefined
      ? Boolean(fallback.preserveLatestPerRoot)
      : Boolean(source.preserveLatestPerRoot)
  };
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function normalizeRootPath(rootPath) {
  return path.resolve(String(rootPath || '/'));
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function compactSummary(status) {
  return {
    cloudOnlyFiles: Number(status.cloudOnlyFiles || 0),
    symlinksSkipped: Number(status.symlinksSkipped || 0),
    unreadableDirectories: Number(status.unreadableDirectories || 0),
    excludedDirectories: Number(status.excludedDirectories || 0),
    hardlinkDuplicates: Number(status.hardlinkDuplicates || 0),
    hardlinkBytesSaved: Number(status.hardlinkBytesSaved || 0),
    cloneDuplicates: Number(status.cloneDuplicates || 0),
    cloneBytesSaved: Number(status.cloneBytesSaved || 0),
    sharedBlockFiles: Number(status.sharedBlockFiles || 0)
  };
}

function isValidRecord(record) {
  return record &&
    typeof record.id === 'string' &&
    typeof record.databaseFile === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.rootPath === 'string' &&
    safeFileName(record.databaseFile);
}

function safeFileName(value) {
  return /^[a-z0-9-]+\.sqlite$/i.test(value);
}

function removeSidecars(databasePath) {
  fs.rmSync(`${databasePath}-shm`, { force: true });
  fs.rmSync(`${databasePath}-wal`, { force: true });
}

function databaseFiles(databasePath) {
  return [databasePath, `${databasePath}-shm`, `${databasePath}-wal`];
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

module.exports = {
  DEFAULT_POLICY,
  HistoryStore,
  normalizePolicy
};
