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

  const scanResult = await execFileAsync(scannerPath, [rootPath, '--database', databasePath], {
    maxBuffer: 4 * 1024 * 1024
  });
  const { stdout: fileColumns } = await execFileAsync('sqlite3', [
    databasePath,
    'SELECT name FROM pragma_table_info(\'files\') ORDER BY cid'
  ]);
  const { stdout: directoryColumns } = await execFileAsync('sqlite3', [
    databasePath,
    'SELECT name FROM pragma_table_info(\'directories\') ORDER BY cid'
  ]);
  assert.equal(fileColumns.split('\n').includes('path'), false);
  assert.equal(fileColumns.split('\n').includes('root_branch_id'), false);
  assert.equal(directoryColumns.split('\n').includes('path'), false);
  assert.equal(directoryColumns.split('\n').includes('path_hash'), true);
  const phases = scanResult.stderr
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line).phase);
  assert.deepEqual(
    [...new Set(phases)],
    ['scanning', 'indexing', 'search-index', 'optimizing', 'ready']
  );
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

test('native scanner deduplicates hard links and full APFS clones', async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'diskstatsx-links-'));
  const rootPath = path.join(temporaryDirectory, 'root');
  const databasePath = path.join(temporaryDirectory, 'scan.sqlite');
  const originalPath = path.join(rootPath, 'original.bin');
  const hardlinkPath = path.join(rootPath, 'hardlink.bin');
  const clonePath = path.join(rootPath, 'clone.bin');
  await fs.mkdir(rootPath, { recursive: true });
  await fs.writeFile(originalPath, Buffer.alloc(64 * 1024, 7));
  await fs.link(originalPath, hardlinkPath);
  let cloneCreated = true;
  try {
    await fs.copyFile(originalPath, clonePath, fs.constants.COPYFILE_FICLONE_FORCE);
  } catch {
    cloneCreated = false;
  }

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
  const hardlinkDuplicate = view.children.find((entry) => entry.hardlinkDuplicate);

  assert.equal(view.scanSummary.hardlinkDuplicates, 1);
  assert.ok(view.scanSummary.hardlinkBytesSaved > 0);
  assert.equal(hardlinkDuplicate.size, 0);
  assert.ok(hardlinkDuplicate.logicalSize > 0);
  if (cloneCreated) {
    assert.equal(view.scanSummary.cloneDuplicates, 1);
    assert.ok(view.scanSummary.cloneBytesSaved > 0);
    assert.equal(view.scanSummary.allocationIsEstimate, true);
  }
});

test('native index searches files, suggests cleanup candidates and compares snapshots', async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'diskstatsx-query-'));
  const rootPath = path.join(temporaryDirectory, 'root');
  const downloadsPath = path.join(rootPath, 'Downloads');
  const beforeDatabase = path.join(temporaryDirectory, 'before.sqlite');
  const afterDatabase = path.join(temporaryDirectory, 'after.sqlite');
  const reportPath = path.join(rootPath, 'release-report.pdf');
  const imagePath = path.join(downloadsPath, 'old-installer.dmg');
  await fs.mkdir(downloadsPath, { recursive: true });
  await fs.writeFile(reportPath, Buffer.alloc(2 * 1024 * 1024, 0x31));
  await fs.writeFile(imagePath, Buffer.alloc(52 * 1024 * 1024, 0x5a));
  const recentTimestamp = new Date();
  await fs.utimes(reportPath, recentTimestamp, recentTimestamp);

  context.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));

  await execFileAsync(scannerPath, [rootPath, '--database', beforeDatabase], {
    maxBuffer: 4 * 1024 * 1024
  });
  const search = await execFileAsync(scannerPath, [
    '--search',
    beforeDatabase,
    'release-report',
    '--extension',
    '.pdf',
    '--min-size',
    String(1024 * 1024),
    '--modified-after',
    String(Math.floor(recentTimestamp.getTime() / 1000) - 60)
  ]);
  const searchResult = JSON.parse(search.stdout);
  assert.equal(searchResult.results.length, 1);
  assert.equal(searchResult.results[0].path, reportPath);
  assert.ok(searchResult.results[0].modifiedAt > 0);

  const pathSearch = await execFileAsync(scannerPath, [
    '--search', beforeDatabase, 'Downloads old-installer'
  ]);
  assert.deepEqual(
    JSON.parse(pathSearch.stdout).results.map((entry) => entry.path),
    [imagePath]
  );

  const tokenizedTerm = Array.from({ length: 120 }, () => 'a').join(' ');
  const tokenizedSearch = await execFileAsync(scannerPath, [
    '--search',
    beforeDatabase,
    tokenizedTerm
  ]);
  assert.ok(Array.isArray(JSON.parse(tokenizedSearch.stdout).results));

  const cleanup = await execFileAsync(scannerPath, [
    '--cleanup',
    beforeDatabase,
    '--limit',
    '10'
  ]);
  const cleanupResult = JSON.parse(cleanup.stdout);
  const diskImage = cleanupResult.results.find((entry) => entry.path === imagePath);
  assert.equal(diskImage.cleanupCategory, 'Disk image');

  await fs.writeFile(path.join(downloadsPath, 'new-build.bin'), Buffer.alloc(2 * 1024 * 1024, 0x24));
  await execFileAsync(scannerPath, [rootPath, '--database', afterDatabase], {
    maxBuffer: 4 * 1024 * 1024
  });
  const comparison = await execFileAsync(scannerPath, [
    '--compare',
    beforeDatabase,
    afterDatabase
  ]);
  const comparisonResult = JSON.parse(comparison.stdout);
  assert.equal(comparisonResult.delta.fileCount, 1);
  assert.ok(comparisonResult.delta.allocatedBytes > 0);
  assert.ok(comparisonResult.changes.some((entry) => (
    entry.path === downloadsPath && entry.kind === 'grown' && entry.delta > 0
  )));
});

test('compact snapshots can search and compare with an existing path-based snapshot', async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'diskstatsx-legacy-'));
  const rootPath = path.join(temporaryDirectory, 'root');
  const compactDatabase = path.join(temporaryDirectory, 'compact.sqlite');
  const legacyDatabase = path.join(temporaryDirectory, 'legacy.sqlite');
  const existingFile = path.join(rootPath, 'existing.bin');
  await fs.mkdir(rootPath);
  await fs.writeFile(existingFile, 'old');
  await fs.writeFile(path.join(rootPath, 'added.bin'), 'new');
  context.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));

  await execFileAsync(scannerPath, [rootPath, '--database', compactDatabase]);
  const legacySql = [
    'CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)',
    'INSERT INTO metadata VALUES(\'root_path\', ' + sqlQuote(rootPath) + ')',
    'CREATE TABLE scan_summary(allocated_bytes INTEGER,logical_bytes INTEGER,' +
      'cloud_only_files INTEGER,symlinks_skipped INTEGER,unreadable_directories INTEGER,' +
      'excluded_directories INTEGER,hardlink_duplicates INTEGER,hardlink_bytes_saved INTEGER,' +
      'clone_duplicates INTEGER,clone_bytes_saved INTEGER,shared_block_files INTEGER)',
    'INSERT INTO scan_summary VALUES(4096,3,0,0,0,0,0,0,0,0,0)',
    'CREATE TABLE directories(id INTEGER PRIMARY KEY,parent_id INTEGER,name TEXT,path TEXT,' +
      'size INTEGER,logical_size INTEGER,direct_file_size INTEGER,file_count INTEGER,' +
      'directory_count INTEGER,direct_file_count INTEGER,direct_directory_count INTEGER)',
    'INSERT INTO directories VALUES(1,NULL,\'root\',' + sqlQuote(rootPath) +
      ',4096,3,4096,1,0,1,0)',
    'CREATE UNIQUE INDEX directories_path ON directories(path)',
    'CREATE TABLE files(id INTEGER PRIMARY KEY,parent_id INTEGER,name TEXT,path TEXT,' +
      'modified_at INTEGER,size INTEGER,logical_size INTEGER,allocated_size INTEGER,' +
      'cloud_only INTEGER,hardlink_duplicate INTEGER,clone_duplicate INTEGER,' +
      'shared_blocks INTEGER,clone_refcount INTEGER,root_branch_id INTEGER)',
    'INSERT INTO files VALUES(1,1,\'existing.bin\',' + sqlQuote(existingFile) +
      ',0,4096,3,4096,0,0,0,0,0,NULL)',
    'CREATE TABLE largest_files(scope TEXT,root_branch_id INTEGER,rank INTEGER,' +
      'name TEXT,path TEXT,size INTEGER,logical_size INTEGER,allocated_size INTEGER,' +
      'cloud_only INTEGER)',
    'CREATE TABLE branch_file_summary(root_branch_id INTEGER,file_count INTEGER,file_size INTEGER)'
  ].join(';') + ';';
  await execFileAsync('sqlite3', [legacyDatabase, legacySql]);

  const legacySearch = await execFileAsync(scannerPath, [
    '--search', legacyDatabase, 'existing'
  ]);
  assert.deepEqual(
    JSON.parse(legacySearch.stdout).results.map((entry) => entry.path),
    [existingFile]
  );
  const legacyView = await execFileAsync(scannerPath, [
    '--query', legacyDatabase, rootPath
  ]);
  assert.equal(JSON.parse(legacyView.stdout).children[0].path, existingFile);

  for (const [before, after] of [
    [legacyDatabase, compactDatabase],
    [compactDatabase, legacyDatabase]
  ]) {
    const comparison = await execFileAsync(scannerPath, ['--compare', before, after]);
    const result = JSON.parse(comparison.stdout);
    assert.equal(Math.abs(result.delta.fileCount), 1);
    assert.equal(result.changes[0].path, rootPath);
  }
});

function sqlQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
