'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const promises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { FileLogger } = require('../server/file-logger');

test('FileLogger writes structured diagnostics and rotates oversized logs', async (context) => {
  const directory = await promises.mkdtemp(path.join(os.tmpdir(), 'diskstatsx-log-'));
  const logPath = path.join(directory, 'diskstatsx.log');
  context.after(() => promises.rm(directory, { recursive: true, force: true }));

  await promises.writeFile(logPath, 'oversized');
  const logger = new FileLogger(logPath, { maxBytes: 4 });
  logger.error('renderer-failed', new Error('test failure'));

  assert.equal(fs.existsSync(`${logPath}.1`), true);
  const entry = JSON.parse(await promises.readFile(logPath, 'utf8'));
  assert.equal(entry.level, 'error');
  assert.equal(entry.event, 'renderer-failed');
  assert.equal(entry.message, 'test failure');
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});
