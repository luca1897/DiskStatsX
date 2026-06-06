'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const scannerPath = path.resolve(__dirname, '..', 'scanner');

test('native index returns a bounded folder view with an Other files cluster', async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'diskstatsx-index-'));
  const rootPath = path.join(temporaryDirectory, 'root');
  const sparsePath = path.join(rootPath, 'sparse');
  const branchPath = path.join(rootPath, 'branch');
  const crowdedPath = path.join(rootPath, 'crowded');
  const databasePath = path.join(temporaryDirectory, 'scan.sqlite');
  await fs.mkdir(sparsePath, { recursive: true });
  await fs.mkdir(branchPath, { recursive: true });
  await fs.mkdir(crowdedPath, { recursive: true });
  await fs.writeFile(path.join(sparsePath, 'online-placeholder.bin'), '');
  await fs.truncate(path.join(sparsePath, 'online-placeholder.bin'), 64 * 1024 * 1024);
  await Promise.all(Array.from({ length: 503 }, (_value, index) => (
    fs.writeFile(path.join(rootPath, `file-${String(index).padStart(3, '0')}.bin`), 'x')
  )));
  await Promise.all([5, 4, 3, 2, 1].map((blocks, index) => (
    fs.writeFile(
      path.join(branchPath, `large-${index + 1}.bin`),
      Buffer.alloc(blocks * 4096)
    )
  )));
  await Promise.all(Array.from({ length: 51 }, (_value, index) => (
    fs.writeFile(path.join(crowdedPath, `small-${String(index).padStart(2, '0')}.bin`), 'x')
  )));

  context.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));

  await execFileAsync(scannerPath, [rootPath, '--database', databasePath], {
    maxBuffer: 4 * 1024 * 1024
  });
  const { stdout } = await execFileAsync(
    scannerPath,
    ['--query', databasePath, rootPath],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  const view = JSON.parse(stdout);
  const aggregate = view.children.find((entry) => entry.aggregateKind === 'files');
  const branch = view.children.find((entry) => entry.path === branchPath);
  const crowded = view.children.find((entry) => entry.path === crowdedPath);
  const crowdedAggregate = crowded.children.find(
    (entry) => entry.aggregateKind === 'files'
  );

  assert.equal(view.lazy, true);
  assert.equal(view.fileCount, 560);
  assert.equal(view.children.filter((entry) => entry.type === 'file').length, 500);
  assert.equal(aggregate.itemCount, 3);
  assert.ok(aggregate.size > 0);
  assert.match(aggregate.path, /^diskstatsx:aggregate:files:/);
  assert.deepEqual(
    branch.children.map((entry) => entry.name),
    ['large-1.bin', 'large-2.bin', 'large-3.bin', 'large-4.bin', 'large-5.bin']
  );
  assert.equal(crowded.children.filter((entry) => entry.type === 'file').length, 48);
  assert.equal(crowdedAggregate.itemCount, 3);
  assert.equal(view.largestFiles.global.length, 10);
  const branchSummary = view.largestFiles.firstLevel.find(
    (entry) => entry.path === branchPath
  );
  assert.deepEqual(
    branchSummary.files.map((entry) => entry.name),
    ['large-1.bin', 'large-2.bin', 'large-3.bin']
  );
  assert.equal(branchSummary.other.itemCount, 2);
  assert.equal(
    branchSummary.other.size,
    3 * 4096
  );

  const sparseResult = await execFileAsync(
    scannerPath,
    ['--query', databasePath, sparsePath],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  const sparseView = JSON.parse(sparseResult.stdout);
  const sparseFile = sparseView.children.find((entry) => entry.type === 'file');
  assert.ok(sparseFile.size < 1024 * 1024);
  assert.equal(sparseFile.cloudOnly, false);
});
