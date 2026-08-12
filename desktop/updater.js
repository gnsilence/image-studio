const { EventEmitter } = require('node:events');

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

class DesktopUpdater extends EventEmitter {
  constructor({ autoUpdater, enabled, hasPendingTasks }) {
    super();
    this.autoUpdater = autoUpdater;
    this.enabled = enabled;
    this.hasPendingTasks = hasPendingTasks;
    this.status = { state: enabled ? 'idle' : 'disabled' };
    this.timer = null;
    this.bindEvents();
  }

  bindEvents() {
    if (!this.enabled) return;
    this.autoUpdater.autoDownload = true;
    this.autoUpdater.autoInstallOnAppQuit = false;
    this.autoUpdater.on('checking-for-update', () => this.setStatus({ state: 'checking' }));
    this.autoUpdater.on('update-available', info => this.setStatus({ state: 'downloading', version: info.version, percent: 0 }));
    this.autoUpdater.on('update-not-available', info => this.setStatus({ state: 'up-to-date', version: info.version }));
    this.autoUpdater.on('download-progress', progress => this.setStatus({
      state: 'downloading',
      percent: Math.round(progress.percent || 0),
      transferred: progress.transferred,
      total: progress.total,
    }));
    this.autoUpdater.on('update-downloaded', info => this.setStatus({ state: 'ready', version: info.version }));
    this.autoUpdater.on('error', error => this.setStatus({ state: 'error', message: error?.message || String(error) }));
  }

  setStatus(next) {
    this.status = { ...this.status, ...next };
    this.emit('status', this.status);
  }

  getStatus() {
    return { ...this.status };
  }

  async check() {
    if (!this.enabled) return this.getStatus();
    try {
      await this.autoUpdater.checkForUpdates();
    } catch (error) {
      this.setStatus({ state: 'error', message: error?.message || String(error) });
    }
    return this.getStatus();
  }

  start() {
    if (!this.enabled || this.timer) return;
    setTimeout(() => void this.check(), 15_000).unref();
    this.timer = setInterval(() => void this.check(), SIX_HOURS_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async restartAndInstall() {
    if (this.status.state !== 'ready') return { installed: false, reason: 'not-ready' };
    if (await this.hasPendingTasks()) return { installed: false, reason: 'tasks-running' };
    this.autoUpdater.quitAndInstall(false, true);
    return { installed: true };
  }
}

module.exports = { DesktopUpdater, SIX_HOURS_MS };
