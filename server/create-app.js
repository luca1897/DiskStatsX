'use strict';

const crypto = require('crypto');
const express = require('express');
const { URL } = require('url');
const { runSystemAction } = require('./system-actions');
const { SseHub } = require('./sse-hub');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SESSION_COOKIE = 'diskstatsx_session';

function normalizeFilters(value) {
  const filters = value && typeof value === 'object' ? value : {};
  return {
    caches: filters.caches === true,
    externalVolumes: filters.externalVolumes === true,
    systemFolders: filters.systemFolders === true
  };
}

function createApp({ scanManager, defaultScanPath = '/', publicPath, vendorPath }) {
  const app = express();
  const events = new SseHub();
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  scanManager.on('status', (event, status) => events.broadcast(event, status));

  app.disable('x-powered-by');
  app.use(validateLocalRequest);
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(publicPath));
  app.use('/vendor', express.static(vendorPath));

  app.get('/config', (_request, response) => {
    response.setHeader('Set-Cookie', serializeSessionCookie(sessionToken));
    response.json({ defaultScanPath });
  });

  app.post('/scan', requireSession(sessionToken), (request, response) => {
    try {
      const rootPath = typeof request.body.path === 'string' ? request.body.path.trim() : '';
      const filters = normalizeFilters(request.body.filters);
      const status = scanManager.start(rootPath, filters);
      response.status(202).json({ ok: true, state: status.state });
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.post('/cancel', requireSession(sessionToken), (_request, response) => {
    try {
      scanManager.cancel();
      response.status(202).json({ ok: true, state: 'canceling' });
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get('/events', requireSession(sessionToken), (request, response) => {
    events.attach(request, response, scanManager.snapshot);
  });

  app.get('/result', requireSession(sessionToken), (_request, response) => {
    if (!scanManager.canServeResult) {
      const running = scanManager.isRunning;
      response.status(running ? 202 : 404).json({
        error: running ? 'scan still running' : 'no scan result available'
      });
      return;
    }
    response.type('application/json');
    response.sendFile(scanManager.resultPath);
  });

  app.post('/system-action', requireSession(sessionToken), (request, response) => {
    try {
      const action = typeof request.body.action === 'string' ? request.body.action : '';
      const requestedPath = typeof request.body.path === 'string' ? request.body.path.trim() : '';
      runSystemAction(action, requestedPath);
      response.json({ ok: true });
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.use((error, _request, response, _next) => {
    response.status(error.statusCode || 500).json({ error: error.message || 'internal server error' });
  });

  return app;
}

function validateLocalRequest(request, response, next) {
  const host = parseHost(request.headers.host);
  if (!host || !LOOPBACK_HOSTS.has(host.hostname)) {
    response.status(403).json({ error: 'request host is not allowed' });
    return;
  }

  if (request.get('sec-fetch-site') === 'cross-site') {
    response.status(403).json({ error: 'cross-site requests are not allowed' });
    return;
  }

  const origin = request.get('origin');
  if (origin && !isSameLocalOrigin(origin, host)) {
    response.status(403).json({ error: 'request origin is not allowed' });
    return;
  }

  next();
}

function parseHost(value) {
  if (!value || /[\s/\\]/.test(value)) {
    return null;
  }
  try {
    const parsed = new URL(`http://${value}`);
    return {
      hostname: parsed.hostname.toLowerCase(),
      host: parsed.host.toLowerCase()
    };
  } catch {
    return null;
  }
}

function isSameLocalOrigin(origin, requestHost) {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) &&
      parsed.host.toLowerCase() === requestHost.host;
  } catch {
    return false;
  }
}

function serializeSessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

function requireSession(expectedToken) {
  return (request, response, next) => {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!safeTokenEqual(token, expectedToken)) {
      response.status(401).json({ error: 'local session is required' });
      return;
    }
    next();
  };
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    cookies[name] = value;
  }
  return cookies;
}

function safeTokenEqual(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

module.exports = {
  createApp,
  normalizeFilters,
  parseHost,
  validateLocalRequest
};
