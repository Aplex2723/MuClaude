'use strict';
// The renderer gets exactly these functions and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mc', {
  init: () => ipcRenderer.invoke('app:init'),
  listCodeProfiles: () => ipcRenderer.invoke('code:list'),
  createCodeProfile: (name) => ipcRenderer.invoke('code:create', name),
  listExternalCode: () => ipcRenderer.invoke('code:external-list'),
  openExternalCode: (dir) => ipcRenderer.invoke('code:external-open', dir),
  revealExternalCode: (dir) => ipcRenderer.invoke('code:external-reveal', dir),
  installCodeCli: () => ipcRenderer.invoke('code:install-cli'),
  uninstallCodeCli: () => ipcRenderer.invoke('code:uninstall'),
  setDirty: (n) => ipcRenderer.invoke('state:dirty', n),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  profileInfo: (dir) => ipcRenderer.invoke('profile:info', dir),
  validateNames: (names) => ipcRenderer.invoke('names:validate', names),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  apply: (cfg) => ipcRenderer.invoke('setup:apply', cfg),
  remove: (opts) => ipcRenderer.invoke('instances:remove', opts),
  openInstance: (name) => ipcRenderer.invoke('instance:open', name),
  beginGoogleLogin: (name) => ipcRenderer.invoke('google-login:begin', name),
  googleLoginStatus: () => ipcRenderer.invoke('google-login:status'),
  cancelGoogleLogin: () => ipcRenderer.invoke('google-login:cancel'),
  appUpdateState: () => ipcRenderer.invoke('app-update:state'),
  checkForAppUpdate: () => ipcRenderer.invoke('app-update:check'),
  installAppUpdate: () => ipcRenderer.invoke('app-update:install'),
  openReleases: () => ipcRenderer.invoke('app-update:releases'),
  onAppUpdate: (fn) => {
    const listener = (_e, state) => fn(state);
    ipcRenderer.on('app-update:state', listener);
    return () => ipcRenderer.removeListener('app-update:state', listener);
  },
  reveal: (dir) => ipcRenderer.invoke('folder:reveal', dir),
  onLog: (fn) => {
    const listener = (_e, line) => fn(String(line));
    ipcRenderer.on('setup:log', listener);
    return () => ipcRenderer.removeListener('setup:log', listener);
  },
});
