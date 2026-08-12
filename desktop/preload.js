const { contextBridge, ipcRenderer } = require('electron');

function unwrap(response) {
  if (!response?.ok) throw new Error(response?.error || '桌面操作失败');
  return response.value;
}

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).then(unwrap);
}

contextBridge.exposeInMainWorld('novaDesktop', Object.freeze({
  platform: process.platform,
  config: Object.freeze({
    get: key => unwrap(ipcRenderer.sendSync('desktop:config:get', key)),
    set: (key, value) => unwrap(ipcRenderer.sendSync('desktop:config:set', key, value)),
    remove: key => unwrap(ipcRenderer.sendSync('desktop:config:remove', key)),
  }),
  records: Object.freeze({
    get: (namespace, key) => invoke('desktop:records:get', namespace, key),
    list: namespace => invoke('desktop:records:list', namespace),
    put: (namespace, key, value) => invoke('desktop:records:put', namespace, key, value),
    delete: (namespace, key) => invoke('desktop:records:delete', namespace, key),
    clear: namespace => invoke('desktop:records:clear', namespace),
  }),
  files: Object.freeze({
    read: (namespace, id) => invoke('desktop:files:read', namespace, id),
    list: namespace => invoke('desktop:files:list', namespace),
    write: (namespace, id, data, mimeType) => invoke('desktop:files:write', namespace, id, data, mimeType),
    delete: (namespace, id) => invoke('desktop:files:delete', namespace, id),
  }),
  s3: Object.freeze({
    getConfig: () => invoke('desktop:s3:config'),
    saveConfig: input => invoke('desktop:s3:save-config', input),
    clearCredentials: () => invoke('desktop:s3:clear-credentials'),
    testConnection: input => invoke('desktop:s3:test', input),
    listFolder: input => invoke('desktop:s3:list-folder', input),
    readThumbnail: object => invoke('desktop:s3:read-thumbnail', object),
    readObject: object => invoke('desktop:s3:read-object', object),
    uploadObject: input => invoke('desktop:s3:upload-object', input),
    createFolder: input => invoke('desktop:s3:create-folder', input),
    downloadObject: object => invoke('desktop:s3:download-object', object),
  }),
  backup: Object.freeze({
    export: () => invoke('desktop:backup:export'),
    import: () => invoke('desktop:backup:import'),
  }),
  updater: Object.freeze({
    check: () => invoke('desktop:updater:check'),
    getStatus: () => invoke('desktop:updater:status'),
    restartAndInstall: () => invoke('desktop:updater:restart'),
    onStatus: callback => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('desktop:updater:status-changed', listener);
      return () => ipcRenderer.removeListener('desktop:updater:status-changed', listener);
    },
  }),
  openDataDirectory: () => invoke('desktop:data:open'),
}));
