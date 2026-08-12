const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { utilityProcess } = require('electron');

class BackendProcess {
  constructor({ appRoot, dataRoot, onUnexpectedExit }) {
    this.appRoot = appRoot;
    this.dataRoot = dataRoot;
    this.onUnexpectedExit = onUnexpectedExit;
    this.child = null;
    this.address = null;
    this.sessionToken = '';
    this.stopping = false;
  }

  start() {
    if (this.child) return Promise.resolve(this.address);
    this.stopping = false;
    this.sessionToken = randomBytes(32).toString('hex');
    const packaged = this.appRoot.endsWith('.asar');
    const runtimeRoot = packaged ? path.dirname(this.appRoot) : this.appRoot;
    const entry = packaged
      ? path.join(runtimeRoot, 'app.asar.unpacked', 'backend', 'server.js')
      : path.join(this.appRoot, 'backend', 'server.js');
    console.log(`[backend] Starting local service from ${entry}`);
    const child = utilityProcess.fork(entry, [], {
      cwd: runtimeRoot,
      serviceName: 'AIOSS Image Local Service',
      stdio: 'pipe',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOSTNAME: '127.0.0.1',
        PORT: '0',
        NOVA_TASK_DB: path.join(this.dataRoot, 'data', 'tasks.sqlite'),
        NOVA_IMAGE_DIR: path.join(this.dataRoot, 'runtime', 'task-images'),
        NOVA_DESKTOP_SESSION_TOKEN: this.sessionToken,
        NOVA_DESKTOP_MODULE_ROOT: this.appRoot,
        NOVA_STATIC_DIR: path.join(this.appRoot, 'frontend', 'out'),
        PROMPT_GALLERY_MODE: '1',
      },
    });
    this.child = child;
    child.stdout?.on('data', chunk => process.stdout.write(`[backend] ${chunk}`));
    child.stderr?.on('data', chunk => process.stderr.write(`[backend] ${chunk}`));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('本地服务启动超时'));
        child.kill();
      }, 30_000);
      const onMessage = message => {
        if (message?.type === 'ready') {
          clearTimeout(timeout);
          this.address = message;
          resolve(message);
        } else if (message?.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(message.message || '本地服务启动失败'));
        }
      };
      child.on('message', onMessage);
      child.once('exit', code => {
        clearTimeout(timeout);
        const unexpected = !this.stopping;
        this.child = null;
        this.address = null;
        if (unexpected) {
          reject(new Error(`本地服务异常退出，代码 ${code}`));
          this.onUnexpectedExit?.(code);
        }
      });
    });
  }

  async getQueueStatus() {
    if (!this.address) return { active: 0, queued: 0 };
    const response = await fetch(`${this.address.url}/api/nova/queue-status`, {
      headers: { 'X-Nova-Desktop-Token': this.sessionToken },
    });
    if (!response.ok) throw new Error(`任务状态读取失败: ${response.status}`);
    return response.json();
  }

  hasPendingTasks() {
    return this.getQueueStatus()
      .then(status => Number(status.processingCount || 0) > 0 || Number(status.queuedCount || 0) > 0)
      .catch(() => false);
  }

  stop(timeoutMs = 8_000) {
    if (!this.child) return Promise.resolve();
    this.stopping = true;
    const child = this.child;
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve();
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      try { child.postMessage({ type: 'stop' }); } catch {
        clearTimeout(timeout);
        try { child.kill(); } catch { /* ignore */ }
        resolve();
      }
    });
  }
}

module.exports = { BackendProcess };
