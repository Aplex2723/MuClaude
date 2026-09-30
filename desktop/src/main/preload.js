'use strict';
// The renderer gets exactly these functions and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mc', {
  init: () => ipcRenderer.invoke('app:init'),
  setDirty: (n) => ipcRenderer.invoke('state:dirty', n),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  profileInfo: (dir) => ipcRenderer.invoke('profile:info', dir),
  validateNames: (names) => ipcRenderer.invoke('names:validate', names),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  apply: (cfg) => ipcRenderer.invoke('setup:apply', cfg),
  remove: (opts) => ipcRenderer.invoke('instances:remove', opts),
  openInstance: (name) => ipcRenderer.invoke('instance:open', name),
  reveal: (dir) => ipcRenderer.invoke('folder:reveal', dir),
  onLog: (fn) => {
    const listener = (_e, line) => fn(String(line));
    ipcRenderer.on('setup:log', listener);
    return () => ipcRenderer.removeListener('setup:log', listener);
  },
});
