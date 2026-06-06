'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../server/create-app');
const { ScanManager } = require('../server/scan-manager');

const projectRoot = path.resolve(__dirname, '..');

test('API scans a directory with native cache exclusions', async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'diskstatsx-test-'));
  const resultPath = path.join(temporaryDirectory, 'result.sqlite');
  const fixturePath = path.join(temporaryDirectory, 'fixture');
  await fs.mkdir(path.join(fixturePath, 'keep', 'nested'), { recursive: true });
  await fs.mkdir(path.join(fixturePath, 'Caches'), { recursive: true });
  await fs.writeFile(path.join(fixturePath, 'keep', 'visible.bin'), Buffer.alloc(4096));
  await fs.writeFile(path.join(fixturePath, 'keep', 'nested', 'deep.bin'), Buffer.alloc(2048));
  await fs.writeFile(path.join(fixturePath, 'Caches', 'hidden.bin'), Buffer.alloc(8192));

  const manager = new ScanManager({
    scannerPath: path.join(projectRoot, 'scanner'),
    resultPath
  });
  const app = createApp({
    scanManager: manager,
    defaultScanPath: fixturePath,
    publicPath: path.join(projectRoot, 'public'),
    vendorPath: path.join(projectRoot, 'node_modules', 'd3', 'dist')
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  context.after(async () => {
    manager.dispose();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const configResponse = await fetch(`${baseUrl}/config`);
  const sessionCookie = configResponse.headers.get('set-cookie').split(';', 1)[0];
  assert.deepEqual(await configResponse.json(), { defaultScanPath: fixturePath });
  const startResponse = await fetch(`${baseUrl}/scan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      path: fixturePath,
      filters: { caches: true }
    })
  });
  assert.equal(startResponse.status, 202);

  await waitForStatus(manager, 'done');
  const resultResponse = await fetch(`${baseUrl}/result`, {
    headers: { Cookie: sessionCookie }
  });
  assert.equal(resultResponse.status, 200);
  assert.ok(manager.snapshot.resultBytes > 0);
  const tree = await resultResponse.json();
  assert.deepEqual(tree.children.map((child) => child.name), ['keep']);
  assert.equal(tree.lazy, true);
  assert.equal(tree.fileCount, 2);
  assert.equal(tree.children[0].fileCount, 2);
  assert.deepEqual(
    tree.children[0].children.map((entry) => entry.name),
    ['nested', 'visible.bin']
  );

  const childResponse = await fetch(
    `${baseUrl}/result?path=${encodeURIComponent(path.join(fixturePath, 'keep'))}`,
    { headers: { Cookie: sessionCookie } }
  );
  assert.equal(childResponse.status, 200);
  const child = await childResponse.json();
  assert.equal(child.parentPath, fixturePath);
  assert.deepEqual(child.children.map((entry) => entry.name), ['nested', 'visible.bin']);
  assert.deepEqual(
    child.breadcrumbs.map((entry) => entry.name),
    ['fixture', 'keep']
  );
});

test('local service rejects foreign hosts, origins and unauthenticated API requests', async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'diskstatsx-security-'));
  const manager = new ScanManager({
    scannerPath: path.join(projectRoot, 'scanner'),
    resultPath: path.join(temporaryDirectory, 'result.sqlite')
  });
  const app = createApp({
    scanManager: manager,
    defaultScanPath: '/private/demo',
    publicPath: path.join(projectRoot, 'public'),
    vendorPath: path.join(projectRoot, 'node_modules', 'd3', 'dist')
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  context.after(async () => {
    manager.dispose();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  const foreignHost = await requestWithHeaders(port, '/config', {
    Host: 'attacker.example'
  });
  assert.equal(foreignHost.status, 403);
  assert.equal(foreignHost.body.includes('/private/demo'), false);

  const foreignOrigin = await requestWithHeaders(port, '/config', {
    Origin: 'https://attacker.example'
  });
  assert.equal(foreignOrigin.status, 403);

  const crossSite = await requestWithHeaders(port, '/config', {
    'Sec-Fetch-Site': 'cross-site'
  });
  assert.equal(crossSite.status, 403);

  const unauthenticatedScan = await fetch(`${baseUrl}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: temporaryDirectory })
  });
  assert.equal(unauthenticatedScan.status, 401);

  const configResponse = await fetch(`${baseUrl}/config`);
  const cookie = configResponse.headers.get('set-cookie');
  assert.match(cookie, /^diskstatsx_session=[A-Za-z0-9_-]+;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test('ScanManager cancels a running native process and removes partial output', async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'diskstatsx-cancel-'));
  const resultPath = path.join(temporaryDirectory, 'result.sqlite');
  const scannerPath = path.join(temporaryDirectory, 'slow-scanner');
  await fs.writeFile(scannerPath, `#!/bin/sh
trap 'exit 143' TERM
printf '{"currentPath":"/tmp","filesScanned":1,"directoriesScanned":1,"bytesDiscovered":4096}\\n' >&2
sleep 10
printf '{"name":"tmp","path":"/tmp","size":0,"type":"directory","children":[]}\\n'
`);
  await fs.chmod(scannerPath, 0o755);

  const manager = new ScanManager({ scannerPath, resultPath });
  context.after(async () => {
    manager.dispose();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  manager.start('/tmp', {
    caches: false,
    externalVolumes: false,
    systemFolders: false
  });
  const canceled = waitForStatus(manager, 'canceled');
  manager.cancel();
  await canceled;

  assert.equal(manager.snapshot.state, 'canceled');
  assert.equal(manager.canServeResult, false);
  await assert.rejects(fs.access(resultPath));
});

function waitForStatus(manager, expectedState, timeoutMs = 5000) {
  if (manager.snapshot.state === expectedState) {
    return Promise.resolve(manager.snapshot);
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      manager.off('status', listener);
      reject(new Error(`Timed out waiting for scan state: ${expectedState}`));
    }, timeoutMs);
    const listener = (_event, status) => {
      if (status.state === expectedState) {
        clearTimeout(timeout);
        manager.off('status', listener);
        resolve(status);
      }
    };
    manager.on('status', listener);
  });
}

function requestWithHeaders(port, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      headers
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body
        });
      });
    });
    request.on('error', reject);
    request.end();
  });
}
