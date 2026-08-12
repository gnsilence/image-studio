const path = require('node:path');
const { openDesktopDatabase } = require('./database');
const { FileStore } = require('./file-store');
const { SecretStore } = require('./secret-store');

const CONFIG_KEYS = new Set([
  'nova-model-registry',
  'nova-jobs',
  'nova-t2i-settings',
  'nova-i2i-settings',
  'nova-reverse-prompt-settings',
  'nova-image-generation-settings',
  'theme',
  'nova-wide-mode',
  'nova-agent-params',
  'nova-agent-web-search',
  'nova-agent-intent-recognition',
  'nova-gif-settings',
  'nova-gif-active-job',
  'nova-gif-tuner-mobile-hint-hidden',
  'nova-assets-settings',
  'nova-image:canvas_config',
  'nova-s3-settings',
]);

const RECORD_NAMESPACES = new Set([
  'generation-jobs',
  'image-records',
  'reverse-results',
  'upload-cache',
  'agent-messages',
  'agent-images',
  'agent-meta',
  'assets',
  'canvas-state',
]);

const RECORD_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,240}$/;
const S3_SECRET_KEYS = Object.freeze({
  accessKeyId: 's3:accessKeyId',
  secretAccessKey: 's3:secretAccessKey',
  sessionToken: 's3:sessionToken',
});

function assertConfigKey(key) {
  if (!CONFIG_KEYS.has(key)) throw new Error(`Unsupported config key: ${key}`);
}

function assertRecord(namespace, key) {
  if (!RECORD_NAMESPACES.has(namespace)) throw new Error(`Unsupported record namespace: ${namespace}`);
  if (!RECORD_KEY_PATTERN.test(key)) throw new Error('Invalid record key');
}

function parseRegistry(value) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid model registry');
  if (!Array.isArray(parsed.imageModels) || !Array.isArray(parsed.textModels)) throw new Error('Invalid model registry');
  return parsed;
}

function secretKey(group, model) {
  if (!model || typeof model.id !== 'string' || !model.id) throw new Error('Model registry contains an invalid model id');
  return `model:${group}:${model.id}:apiKey`;
}

class StorageService {
  constructor({ dataRoot, safeStorage }) {
    this.dataRoot = path.resolve(dataRoot);
    this.dbPath = path.join(this.dataRoot, 'data', 'app.sqlite');
    this.filesPath = path.join(this.dataRoot, 'files');
    this.db = openDesktopDatabase(this.dbPath);
    this.secrets = new SecretStore(this.db, safeStorage);
    this.files = new FileStore(this.db, this.filesPath);
    this.files.cleanup();
  }

  configGet(key) {
    assertConfigKey(key);
    const row = this.db.prepare('SELECT value_json FROM app_settings WHERE namespace = ? AND storage_key = ?')
      .get('config', key);
    if (!row) return null;
    const value = JSON.parse(row.value_json);
    if (key !== 'nova-model-registry') return value;
    const registry = parseRegistry(value);
    for (const [group, models] of [['image', registry.imageModels], ['text', registry.textModels]]) {
      for (const model of models) model.apiKey = this.secrets.get(secretKey(group, model));
    }
    return JSON.stringify(registry);
  }

  configSet(key, value) {
    assertConfigKey(key);
    if (typeof value !== 'string') throw new Error('Config values must be strings');
    if (Buffer.byteLength(value, 'utf8') > 5 * 1024 * 1024) throw new Error('Config value is too large');
    const now = new Date().toISOString();

    if (key === 'nova-model-registry') {
      const registry = parseRegistry(value);
      this.db.transaction(() => {
        const retainedSecretKeys = new Set();
        for (const [group, models] of [['image', registry.imageModels], ['text', registry.textModels]]) {
          for (const model of models) {
            const keyName = secretKey(group, model);
            retainedSecretKeys.add(keyName);
            this.secrets.set(keyName, typeof model.apiKey === 'string' ? model.apiKey : '');
            model.apiKey = '';
          }
        }
        const existingKeys = this.db.prepare("SELECT storage_key FROM app_secrets WHERE storage_key LIKE 'model:%:apiKey'").all();
        for (const row of existingKeys) {
          if (!retainedSecretKeys.has(row.storage_key)) this.secrets.delete(row.storage_key);
        }
        this.upsertConfig(key, JSON.stringify(registry), now);
      })();
      return;
    }

    this.upsertConfig(key, value, now);
  }

  upsertConfig(key, value, now) {
    this.db.prepare(`
      INSERT INTO app_settings (namespace, storage_key, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(namespace, storage_key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run('config', key, JSON.stringify(value), now);
  }

  configRemove(key) {
    assertConfigKey(key);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM app_settings WHERE namespace = ? AND storage_key = ?').run('config', key);
      if (key === 'nova-model-registry') this.db.prepare("DELETE FROM app_secrets WHERE storage_key LIKE 'model:%:apiKey'").run();
    })();
  }

  s3GetCredentials() {
    return {
      accessKeyId: this.secrets.get(S3_SECRET_KEYS.accessKeyId),
      secretAccessKey: this.secrets.get(S3_SECRET_KEYS.secretAccessKey),
      sessionToken: this.secrets.get(S3_SECRET_KEYS.sessionToken),
    };
  }

  s3GetCredentialStatus() {
    const credentials = this.s3GetCredentials();
    return {
      hasAccessKeyId: Boolean(credentials.accessKeyId),
      hasSecretAccessKey: Boolean(credentials.secretAccessKey),
      hasSessionToken: Boolean(credentials.sessionToken),
    };
  }

  s3SaveSettings(settingsJson, credentials) {
    if (typeof settingsJson !== 'string') throw new Error('S3 settings must be a JSON string');
    this.db.transaction(() => {
      this.configSet('nova-s3-settings', settingsJson);
      if (!credentials) return;
      this.secrets.set(S3_SECRET_KEYS.accessKeyId, credentials.accessKeyId);
      this.secrets.set(S3_SECRET_KEYS.secretAccessKey, credentials.secretAccessKey);
      if (credentials.sessionToken) this.secrets.set(S3_SECRET_KEYS.sessionToken, credentials.sessionToken);
      else this.secrets.delete(S3_SECRET_KEYS.sessionToken);
    })();
  }

  s3ClearCredentials() {
    this.db.transaction(() => {
      for (const key of Object.values(S3_SECRET_KEYS)) this.secrets.delete(key);
    })();
  }

  recordGet(namespace, key) {
    assertRecord(namespace, key);
    const row = this.db.prepare('SELECT value_json FROM app_records WHERE namespace = ? AND record_key = ?').get(namespace, key);
    return row ? JSON.parse(row.value_json) : null;
  }

  recordList(namespace) {
    if (!RECORD_NAMESPACES.has(namespace)) throw new Error(`Unsupported record namespace: ${namespace}`);
    return this.db.prepare(`
      SELECT record_key, value_json, created_at, updated_at
      FROM app_records WHERE namespace = ? ORDER BY updated_at DESC
    `).all(namespace).map(row => ({
      key: row.record_key,
      value: JSON.parse(row.value_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  recordPut(namespace, key, value) {
    assertRecord(namespace, key);
    const valueJson = JSON.stringify(value);
    if (valueJson === undefined) throw new Error('Record value is not JSON serializable');
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO app_records (namespace, record_key, value_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(namespace, record_key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(namespace, key, valueJson, now, now);
  }

  recordDelete(namespace, key) {
    assertRecord(namespace, key);
    this.db.prepare('DELETE FROM app_records WHERE namespace = ? AND record_key = ?').run(namespace, key);
  }

  recordClear(namespace) {
    if (!RECORD_NAMESPACES.has(namespace)) throw new Error(`Unsupported record namespace: ${namespace}`);
    this.db.prepare('DELETE FROM app_records WHERE namespace = ?').run(namespace);
  }

  close() {
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    this.db.close();
  }
}

module.exports = { CONFIG_KEYS, RECORD_NAMESPACES, S3_SECRET_KEYS, StorageService };
