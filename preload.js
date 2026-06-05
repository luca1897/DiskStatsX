'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diskStatsX', {
  platform: process.platform,
  selectDirectory: () => ipcRenderer.invoke('diskstatsx:select-directory')
});
