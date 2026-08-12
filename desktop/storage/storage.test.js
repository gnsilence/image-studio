const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { StorageService } = require('./storage-service');

function makeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: buffer => Buffer.from(buffer.toString().slice('encrypted:'.length), 'base64').toString(),
  };
}

function withStorage(t, safeStorage = makeSafeStorage()) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-desktop-storage-'));
  const storage = new StorageService({ dataRoot, safeStorage });
  t.after(() => {
    try { storage.close(); } catch { /* ignore */ }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  return { dataRoot, storage };
}

test('runs the initial migration and persists namespaced configuration and records', t => {
  const { storage } = withStorage(t);
  assert.equal(storage.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 1);
  assert.equal(storage.db.pragma('quick_check', { simple: true }), 'ok');

  storage.configSet('theme', 'dark');
  assert.equal(storage.configGet('theme'), 'dark');
  storage.configRemove('theme');
  assert.equal(storage.configGet('theme'), null);

  storage.recordPut('generation-jobs', 'job-1', { status: 'completed', prompt: 'city' });
  assert.deepEqual(storage.recordGet('generation-jobs', 'job-1'), { status: 'completed', prompt: 'city' });
  assert.equal(storage.recordList('generation-jobs')[0].key, 'job-1');
  storage.recordDelete('generation-jobs', 'job-1');
  assert.equal(storage.recordGet('generation-jobs', 'job-1'), null);
});

test('stores model API keys only as encrypted secret rows', t => {
  const { storage } = withStorage(t);
  const registry = {
    imageModels: [{ id: 'image-model', apiKey: 'image-secret' }],
    textModels: [{ id: 'text-model', apiKey: 'text-secret' }],
    defaults: {},
  };
  storage.configSet('nova-model-registry', JSON.stringify(registry));

  const stored = storage.db.prepare("SELECT value_json FROM app_settings WHERE storage_key = 'nova-model-registry'").get().value_json;
  assert.equal(stored.includes('image-secret'), false);
  assert.equal(stored.includes('text-secret'), false);
  const ciphertext = storage.db.prepare('SELECT ciphertext FROM app_secrets ORDER BY storage_key LIMIT 1').get().ciphertext;
  assert.notEqual(Buffer.from(ciphertext).toString(), 'image-secret');

  const restored = JSON.parse(storage.configGet('nova-model-registry'));
  assert.equal(restored.imageModels[0].apiKey, 'image-secret');
  assert.equal(restored.textModels[0].apiKey, 'text-secret');
});

test('refuses to persist a model secret when system encryption is unavailable', t => {
  const { storage } = withStorage(t, makeSafeStorage(false));
  assert.throws(() => storage.configSet('nova-model-registry', JSON.stringify({
    imageModels: [{ id: 'image-model', apiKey: 'secret' }],
    textModels: [],
    defaults: {},
  })), /加密不可用/);
  assert.equal(storage.configGet('nova-model-registry'), null);
});

test('stores S3 credentials only in encrypted secret rows', t => {
  const { storage } = withStorage(t);
  storage.s3SaveSettings(JSON.stringify({
    endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'assets', rootPrefix: '', forcePathStyle: false,
  }), {
    accessKeyId: 's3-access', secretAccessKey: 's3-secret', sessionToken: 's3-token',
  });
  const settings = storage.db.prepare("SELECT value_json FROM app_settings WHERE storage_key = 'nova-s3-settings'").get().value_json;
  assert.equal(settings.includes('s3-access'), false);
  assert.equal(settings.includes('s3-secret'), false);
  assert.equal(settings.includes('s3-token'), false);
  const ciphertext = storage.db.prepare("SELECT ciphertext FROM app_secrets WHERE storage_key LIKE 's3:%'").all();
  assert.equal(ciphertext.length, 3);
  assert.equal(ciphertext.every(row => Buffer.from(row.ciphertext).toString().startsWith('encrypted:')), true);
  assert.deepEqual(storage.s3GetCredentials(), {
    accessKeyId: 's3-access', secretAccessKey: 's3-secret', sessionToken: 's3-token',
  });
});

test('writes files atomically inside allowlisted namespaces and removes orphans', t => {
  const { dataRoot, storage } = withStorage(t);
  const descriptor = storage.files.write('history', 'job-1:0', Buffer.from('image-bytes'), 'image/png');
  assert.equal(descriptor.sha256.length, 64);
  const restored = storage.files.read('history', 'job-1:0');
  assert.equal(restored.data.toString(), 'image-bytes');
  assert.equal(restored.mimeType, 'image/png');

  assert.throws(() => storage.files.write('history', '../outside', Buffer.from('x')), /Invalid file id/);
  assert.throws(() => storage.files.write('unknown', 'file-1', Buffer.from('x')), /Unsupported file namespace/);

  const orphanPath = path.join(dataRoot, 'files', 'history', 'orphan.png');
  fs.writeFileSync(orphanPath, 'orphan');
  assert.equal(storage.files.cleanup(), 1);
  assert.equal(fs.existsSync(orphanPath), false);

  storage.files.delete('history', 'job-1:0');
  assert.equal(storage.files.read('history', 'job-1:0'), null);
});
