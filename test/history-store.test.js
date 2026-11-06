'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const promises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { HistoryStore } = require('../server/history-store');

const MIB = 1024 * 1024;

test('HistoryStore prunes oldest unprotected snapshots by count and bytes', async (context) => {
  const temporaryDirectory = await promises.mkdtemp(path.join(os.tmpdir(), 'diskstatsx-policy-'));
  context.after(() => promises.rm(temporaryDirectory, { recursive: true, force: true }));
  const store = new HistoryStore(temporaryDirectory, {
    limit: 3,
    maxBytes: 256 * MIB,
    preserveLatestPerRoot: true
  });

  addSnapshot(store, temporaryDirectory, '/Users/demo', 100 * MIB, 1);
  addSnapshot(store, temporaryDirectory, '/Users/demo', 100 * MIB, 2);
  const librarySnapshot = addSnapshot(store, temporaryDirectory, '/Library', 96 * MIB, 3);
  fs.closeSync(fs.openSync(`${librarySnapshot.databasePath}-wal`, 'w'));
  fs.truncateSync(`${librarySnapshot.databasePath}-wal`, 4 * MIB);

  assert.deepEqual(store.list().map((record) => record.rootPath), [
    '/Library',
    '/Users/demo'
  ]);
  assert.equal(store.summary().protectedCount, 2);
  assert.equal(store.list()[0].resultBytes, 100 * MIB);
  assert.ok(store.summary().totalBytes <= 256 * MIB);

  addSnapshot(store, temporaryDirectory, '/Users/demo', 100 * MIB, 4);
  assert.deepEqual(store.list().map((record) => record.rootPath), [
    '/Users/demo',
    '/Library'
  ]);

  const result = store.updatePolicy({
    maxSnapshots: 1,
    maxBytes: 256 * MIB,
    preserveLatestPerRoot: false
  });
  assert.equal(result.removed.length, 1);
  assert.deepEqual(store.list().map((record) => record.rootPath), ['/Users/demo']);
  assert.equal(store.summary().policyConfigured, true);

  const restored = new HistoryStore(temporaryDirectory);
  assert.deepEqual(restored.summary().policy, {
    maxSnapshots: 1,
    maxBytes: 256 * MIB,
    preserveLatestPerRoot: false
  });
});

function addSnapshot(store, directory, rootPath, bytes, sequence) {
  const workingPath = path.join(directory, `working-${sequence}.sqlite`);
  fs.closeSync(fs.openSync(workingPath, 'w'));
  fs.truncateSync(workingPath, bytes);
  return store.add(workingPath, {
    rootPath,
    filesScanned: sequence,
    directoriesScanned: 1,
    bytesDiscovered: bytes,
    elapsedMs: sequence
  }, bytes);
}
