const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  safeStorage,
  session,
  shell,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const { BackendProcess } = require('./backend-process');
const { registerDesktopIpc } = require('./ipc');
const { BackupService } = require('./storage/backup-service');
const { S3Service } = require('./s3-service');
const { StorageService } = require('./storage/storage-service');
const { DesktopUpdater } = require('./updater');

const APP_NAME = 'AIOSS Image';
const DATA_DIRECTORY_NAME = 'Nova Image Studio';
const localAppData = process.env.NOVA_DESKTOP_DATA_ROOT
  || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), DATA_DIRECTORY_NAME);
app.setName(APP_NAME);
app.setPath('userData', localAppData);

let mainWindow = null;
let storage = null;
let backend = null;
let updater = null;
let s3Service = null;
let disposeIpc = null;
let quitting = false;
let shutdownComplete = false;
let closeApproved = false;
let backendRestartCount = 0;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function isAllowedExternalUrl(rawUrl) {
  try {
    return new URL(rawUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

function attachDesktopToken(address, token) {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const target = new URL(details.url);
      const sameHost = target.hostname === address.host && Number(target.port) === Number(address.port);
      if (sameHost && (target.protocol === 'http:' || target.protocol === 'ws:')) {
        details.requestHeaders['X-Nova-Desktop-Token'] = token;
      }
    } catch {
      // Leave unrelated requests untouched.
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}

async function startBackendWithRetry() {
  for (;;) {
    try {
      return await backend.start();
    } catch (error) {
      const choice = await dialog.showMessageBox({
        type: 'error',
        title: 'AIOSS Image 本地服务启动失败',
        message: error?.message || 'AIOSS Image 本地服务启动失败',
        buttons: ['重试', '打开数据目录', '退出'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (choice.response === 1) {
        await shell.openPath(localAppData);
        continue;
      }
      if (choice.response === 2) throw error;
    }
  }
}

async function createMainWindow() {
  const address = await startBackendWithRetry();
  attachDesktopToken(address, backend.sessionToken);
  const windowOptions = {
    title: 'AIOSS Image - AI 图像生成器',
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    show: false,
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  };
  if (process.platform === 'win32') {
    windowOptions.icon = path.join(app.getAppPath(), 'frontend', 'out', 'app.ico');
  }
  const window = new BrowserWindow(windowOptions);
  mainWindow = window;

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const local = new URL(address.url);
    if (target.origin !== local.origin) {
      event.preventDefault();
      if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    }
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', async event => {
    if (quitting || closeApproved) return;
    event.preventDefault();
    const pending = await backend.hasPendingTasks();
    if (pending) {
      const answer = await dialog.showMessageBox(window, {
        type: 'warning',
        title: '仍有任务运行',
        message: '退出会中断正在排队或生成的任务。',
        buttons: ['继续使用', '退出'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return;
    }
    closeApproved = true;
    app.quit();
  });
  window.on('closed', () => { mainWindow = null; });

  await window.loadURL(`${address.url}/`);
  return window;
}

async function handleUnexpectedBackendExit() {
  if (quitting || !mainWindow) return;
  if (backendRestartCount < 1) {
    backendRestartCount += 1;
    try {
      const address = await backend.start();
      attachDesktopToken(address, backend.sessionToken);
      await mainWindow.loadURL(`${address.url}/`);
      return;
    } catch {
      // Fall through to the explicit recovery dialog.
    }
  }
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: '本地服务已停止',
    message: '本地任务服务异常退出，当前任务可能已中断。',
    buttons: ['重新启动', '退出'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (answer.response === 0) {
    backendRestartCount = 0;
    const address = await startBackendWithRetry();
    attachDesktopToken(address, backend.sessionToken);
    await mainWindow.loadURL(`${address.url}/`);
  } else {
    app.quit();
  }
}

async function initialize() {
  storage = new StorageService({ dataRoot: localAppData, safeStorage });
  s3Service = new S3Service({
    getStorage: () => storage,
    dialog,
    getWindow: () => mainWindow,
  });
  s3Service.cleanupCache();
  backend = new BackendProcess({
    appRoot: app.getAppPath(),
    dataRoot: localAppData,
    onUnexpectedExit: () => void handleUnexpectedBackendExit(),
  });
  updater = new DesktopUpdater({
    autoUpdater,
    enabled: app.isPackaged,
    hasPendingTasks: () => backend.hasPendingTasks(),
  });
  const backupService = new BackupService({
    dataRoot: localAppData,
    safeStorage,
    getStorage: () => storage,
    replaceStorage: next => {
      storage = next;
      s3Service.invalidateClient();
    },
    appVersion: app.getVersion(),
  });
  disposeIpc = registerDesktopIpc({
    getStorage: () => storage,
    backupService,
    s3Service,
    updater,
    dataRoot: localAppData,
    getWindow: () => mainWindow,
  });
  updater.on('status', status => mainWindow?.webContents.send('desktop:updater:status-changed', status));
  updater.start();
  await createMainWindow();
}

async function shutdown() {
  updater?.stop();
  disposeIpc?.();
  disposeIpc = null;
  await backend?.stop();
  s3Service?.destroy();
  s3Service = null;
  try { storage?.close(); } catch { /* ignore */ }
  storage = null;
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('before-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void shutdown().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});

app.on('window-all-closed', () => app.quit());

app.whenReady()
  .then(initialize)
  .catch(error => {
    dialog.showErrorBox('AIOSS Image 启动失败', error?.stack || error?.message || String(error));
    shutdownComplete = true;
    app.quit();
  });
