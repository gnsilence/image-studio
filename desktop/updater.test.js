const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { DesktopUpdater, SIX_HOURS_MS } = require('./updater');

class FakeAutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.checkCount = 0;
    this.installCount = 0;
  }

  async checkForUpdates() {
    this.checkCount += 1;
  }

  quitAndInstall() {
    this.installCount += 1;
  }
}

test('maps updater events to renderer-safe status objects', async () => {
  const autoUpdater = new FakeAutoUpdater();
  const updater = new DesktopUpdater({ autoUpdater, enabled: true, hasPendingTasks: async () => false });
  autoUpdater.emit('update-available', { version: '4.0.0' });
  assert.deepEqual(updater.getStatus(), { state: 'downloading', version: '4.0.0', percent: 0 });
  autoUpdater.emit('download-progress', { percent: 42.4, transferred: 42, total: 100 });
  assert.equal(updater.getStatus().percent, 42);
  autoUpdater.emit('update-downloaded', { version: '4.0.0' });
  assert.equal(updater.getStatus().state, 'ready');
  assert.equal((await updater.restartAndInstall()).installed, true);
  assert.equal(autoUpdater.installCount, 1);
  assert.equal(SIX_HOURS_MS, 21_600_000);
});

test('does not install a downloaded update while tasks are running', async () => {
  const autoUpdater = new FakeAutoUpdater();
  const updater = new DesktopUpdater({ autoUpdater, enabled: true, hasPendingTasks: async () => true });
  autoUpdater.emit('update-downloaded', { version: '4.0.0' });
  assert.deepEqual(await updater.restartAndInstall(), { installed: false, reason: 'tasks-running' });
  assert.equal(autoUpdater.installCount, 0);
});

test('keeps update calls disabled in development', async () => {
  const autoUpdater = new FakeAutoUpdater();
  const updater = new DesktopUpdater({ autoUpdater, enabled: false, hasPendingTasks: async () => false });
  assert.equal((await updater.check()).state, 'disabled');
  assert.equal(autoUpdater.checkCount, 0);
});
