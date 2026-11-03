const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('navapi', {
  action: (a) => ipcRenderer.send('nav', a),
  onState: (cb) => ipcRenderer.on('nav-state', (_e, s) => cb(s)),
});
