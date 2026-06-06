'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

class FileLogger {
  constructor(filePath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.rotateIfNeeded();
  }

  info(event, details) {
    this.write('info', event, details);
  }

  warn(event, details) {
    this.write('warn', event, details);
  }

  error(event, details) {
    this.write('error', event, details);
  }

  write(level, event, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...normalizeDetails(details)
    };
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // Diagnostics must never crash the application.
    }
  }

  rotateIfNeeded() {
    try {
      if (fs.statSync(this.filePath).size < this.maxBytes) {
        return;
      }
      fs.renameSync(this.filePath, `${this.filePath}.1`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        try {
          fs.rmSync(`${this.filePath}.1`, { force: true });
          fs.renameSync(this.filePath, `${this.filePath}.1`);
        } catch {
          // Start a fresh log when rotation cannot be completed.
        }
      }
    }
  }
}

function normalizeDetails(details) {
  if (details instanceof Error) {
    return {
      message: details.message,
      stack: details.stack
    };
  }
  if (!details || typeof details !== 'object') {
    return { value: details };
  }
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      value instanceof Error
        ? { message: value.message, stack: value.stack }
        : value
    ])
  );
}

module.exports = { FileLogger };
