'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_FILE = 'history.json';

class HistoryStore {
  constructor(directory, { limit = 12 } = {}) {
    this.directory = directory;
    this.limit = limit;
    fs.mkdirSync(directory, { recursive: true });
    this.manifestPath = path.join(directory, MANIFEST_FILE);
    this.records = this.load();
  }

  list() {
    return this.records.map((record) => ({ ...record }));
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

  prune() {
    const removed = this.records.splice(this.limit);
    for (const record of removed) {
      const databasePath = path.join(this.directory, record.databaseFile);
      fs.rmSync(databasePath, { force: true });
      removeSidecars(databasePath);
    }
  }

  save() {
    const temporary = `${this.manifestPath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.records, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, this.manifestPath);
  }
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

module.exports = { HistoryStore };
