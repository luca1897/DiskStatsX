'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ALLOWED_ACTIONS = new Set(['open', 'reveal']);

function runSystemAction(action, requestedPath) {
  if (!ALLOWED_ACTIONS.has(action) || !requestedPath) {
    const error = new Error('invalid system action');
    error.statusCode = 400;
    throw error;
  }

  const targetPath = path.resolve(requestedPath);
  if (!fs.existsSync(targetPath)) {
    const error = new Error('path does not exist');
    error.statusCode = 404;
    throw error;
  }

  const args = action === 'reveal' ? ['-R', targetPath] : [targetPath];
  const child = spawn('/usr/bin/open', args, {
    detached: true,
    stdio: 'ignore'
  });
  child.on('error', () => {});
  child.unref();
}

module.exports = { runSystemAction };
