'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function reportRendererError(type, error, source = {}) {
  ipcRenderer.send('diskstatsx:renderer-error', {
    type,
    message: error?.message || String(error || 'Unknown renderer error'),
    stack: error?.stack || '',
    source: source.filename || '',
    line: source.lineno || 0,
    column: source.colno || 0
  });
}

globalThis.addEventListener('error', (event) => {
  reportRendererError('error', event.error || event.message, event);
});

globalThis.addEventListener('unhandledrejection', (event) => {
  reportRendererError('unhandledrejection', event.reason);
});

contextBridge.exposeInMainWorld('diskStatsX', {
  platform: process.platform,
  selectDirectory: () => ipcRenderer.invoke('diskstatsx:select-directory')
});
