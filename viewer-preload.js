const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the in-app image viewer (viewer.html)
contextBridge.exposeInMainWorld('viewer', {
  // kind: 'preview' (the chat thumbnail) or 'full'
  onImage: (cb) => ipcRenderer.on('viewer:image', (e, url, kind) => cb(url, kind)),
  // a video link: direct MP4 URL plus an optional poster image
  onVideo: (cb) => ipcRenderer.on('viewer:video', (e, url, poster) => cb(url, poster)),
  videoError: (info) => ipcRenderer.send('viewer:video-error', String(info || '')),
  onStatus: (cb) => ipcRenderer.on('viewer:status', (e, status) => cb(status)),
  // a new photo of the gallery is about to be shown: { index, total }
  onReset: (cb) => ipcRenderer.on('viewer:reset', (e, info) => cb(info)),
  shown: (url) => ipcRenderer.send('viewer:shown', url),
  navigate: (step) => ipcRenderer.send('viewer:navigate', step),
  playVideo: () => ipcRenderer.send('viewer:play-video'),
  close: () => ipcRenderer.send('viewer:close'),
  openInBrowser: () => ipcRenderer.send('viewer:open-browser'),
  copyLink: () => ipcRenderer.send('viewer:copy-link'),
  save: () => ipcRenderer.send('viewer:save'),
  copyImage: (x, y) => ipcRenderer.send('viewer:copy-image', x, y),
  contextMenu: (x, y, onImage) => ipcRenderer.send('viewer:context-menu', x, y, onImage),
});
