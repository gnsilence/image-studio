const { dialog, ipcMain, shell } = require('electron');

const CHANNELS = [
  'desktop:records:get',
  'desktop:records:list',
  'desktop:records:put',
  'desktop:records:delete',
  'desktop:records:clear',
  'desktop:files:read',
  'desktop:files:list',
  'desktop:files:write',
  'desktop:files:delete',
  'desktop:backup:export',
  'desktop:backup:import',
  'desktop:s3:config',
  'desktop:s3:save-config',
  'desktop:s3:clear-credentials',
  'desktop:s3:test',
  'desktop:s3:list-folder',
  'desktop:s3:read-thumbnail',
  'desktop:s3:read-object',
  'desktop:s3:upload-object',
  'desktop:s3:create-folder',
  'desktop:s3:download-object',
  'desktop:updater:check',
  'desktop:updater:status',
  'desktop:updater:restart',
  'desktop:data:open',
];

function result(handler) {
  try {
    return { ok: true, value: handler() };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function asyncResult(handler) {
  return Promise.resolve()
    .then(handler)
    .then(value => ({ ok: true, value }))
    .catch(error => ({ ok: false, error: error?.message || String(error) }));
}

function registerDesktopIpc({ getStorage, backupService, s3Service, updater, dataRoot, getWindow }) {
  ipcMain.on('desktop:config:get', (event, key) => { event.returnValue = result(() => getStorage().configGet(key)); });
  ipcMain.on('desktop:config:set', (event, key, value) => { event.returnValue = result(() => getStorage().configSet(key, value)); });
  ipcMain.on('desktop:config:remove', (event, key) => { event.returnValue = result(() => getStorage().configRemove(key)); });

  ipcMain.handle('desktop:records:get', (_event, namespace, key) => asyncResult(() => getStorage().recordGet(namespace, key)));
  ipcMain.handle('desktop:records:list', (_event, namespace) => asyncResult(() => getStorage().recordList(namespace)));
  ipcMain.handle('desktop:records:put', (_event, namespace, key, value) => asyncResult(() => getStorage().recordPut(namespace, key, value)));
  ipcMain.handle('desktop:records:delete', (_event, namespace, key) => asyncResult(() => getStorage().recordDelete(namespace, key)));
  ipcMain.handle('desktop:records:clear', (_event, namespace) => asyncResult(() => getStorage().recordClear(namespace)));
  ipcMain.handle('desktop:files:read', (_event, namespace, id) => asyncResult(() => {
    const stored = getStorage().files.read(namespace, id);
    return stored ? { ...stored, data: new Uint8Array(stored.data) } : null;
  }));
  ipcMain.handle('desktop:files:list', (_event, namespace) => asyncResult(() => getStorage().files.list(namespace)));
  ipcMain.handle('desktop:files:write', (_event, namespace, id, data, mimeType) => asyncResult(() => (
    getStorage().files.write(namespace, id, Buffer.from(data), mimeType)
  )));
  ipcMain.handle('desktop:files:delete', (_event, namespace, id) => asyncResult(() => getStorage().files.delete(namespace, id)));

  ipcMain.handle('desktop:backup:export', () => asyncResult(async () => {
    const target = await dialog.showSaveDialog(getWindow(), {
      title: '导出 AIOSS Image 备份',
      defaultPath: backupService.defaultFileName(),
      filters: [{ name: 'ZIP 备份', extensions: ['zip'] }],
    });
    if (target.canceled || !target.filePath) return { canceled: true };
    await backupService.exportTo(target.filePath);
    return { canceled: false, filePath: target.filePath };
  }));
  ipcMain.handle('desktop:backup:import', () => asyncResult(async () => {
    const target = await dialog.showOpenDialog(getWindow(), {
      title: '导入 AIOSS Image 备份',
      properties: ['openFile'],
      filters: [{ name: 'ZIP 备份', extensions: ['zip'] }],
    });
    if (target.canceled || !target.filePaths[0]) return { canceled: true };
    await backupService.importFrom(target.filePaths[0]);
    return { canceled: false };
  }));

  ipcMain.handle('desktop:s3:config', () => asyncResult(() => s3Service.getConfig()));
  ipcMain.handle('desktop:s3:save-config', (_event, input) => asyncResult(() => s3Service.saveConfig(input)));
  ipcMain.handle('desktop:s3:clear-credentials', () => asyncResult(() => s3Service.clearCredentials()));
  ipcMain.handle('desktop:s3:test', (_event, input) => asyncResult(() => s3Service.testConnection(input)));
  ipcMain.handle('desktop:s3:list-folder', (_event, input) => asyncResult(() => s3Service.listFolder(input)));
  ipcMain.handle('desktop:s3:read-thumbnail', (_event, input) => asyncResult(async () => {
    const stored = await s3Service.readThumbnail(input);
    return { ...stored, data: new Uint8Array(stored.data) };
  }));
  ipcMain.handle('desktop:s3:read-object', (_event, input) => asyncResult(async () => {
    const stored = await s3Service.readObject(input);
    return { ...stored, data: new Uint8Array(stored.data) };
  }));
  ipcMain.handle('desktop:s3:upload-object', (_event, input) => asyncResult(() => (
    s3Service.uploadObject({ ...input, data: Buffer.from(input?.data || []) })
  )));
  ipcMain.handle('desktop:s3:create-folder', (_event, input) => asyncResult(() => s3Service.createFolder(input)));
  ipcMain.handle('desktop:s3:download-object', (_event, input) => asyncResult(() => s3Service.downloadObject(input)));

  ipcMain.handle('desktop:updater:check', () => asyncResult(() => updater.check()));
  ipcMain.handle('desktop:updater:status', () => asyncResult(() => updater.getStatus()));
  ipcMain.handle('desktop:updater:restart', () => asyncResult(() => updater.restartAndInstall()));
  ipcMain.handle('desktop:data:open', () => asyncResult(() => shell.openPath(dataRoot)));

  return () => {
    ipcMain.removeAllListeners('desktop:config:get');
    ipcMain.removeAllListeners('desktop:config:set');
    ipcMain.removeAllListeners('desktop:config:remove');
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerDesktopIpc };
