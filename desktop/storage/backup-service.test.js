const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { strToU8, zipSync } = require('fflate');
const unzipper = require('unzipper');
const { BackupService, safeEntryPath } = require('./backup-service');
const { StorageService } = require('./storage-service');

function makeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: buffer => Buffer.from(buffer.toString().slice('encrypted:'.length), 'base64').toString(),
  };
}

function makeManager(root, safeStorage) {
  let storage = new StorageService({ dataRoot: root, safeStorage });
  const backup = new BackupService({
    dataRoot: root,
    safeStorage,
    getStorage: () => storage,
    replaceStorage: next => { storage = next; },
    appVersion: 'test',
  });
  return { backup, getStorage: () => storage };
}

function writeZip(filePath, files) {
  fs.writeFileSync(filePath, zipSync(Object.fromEntries(
    Object.entries(files).map(([key, value]) => [key, typeof value === 'string' ? strToU8(value) : value])
  )));
}

test('desktop backup round-trips records and files without exporting model API keys', async t => {
  const safeStorage = makeSafeStorage();
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-backup-source-'));
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-backup-target-'));
  const zipPath = path.join(os.tmpdir(), `nova-backup-${Date.now()}.zip`);
  const source = makeManager(sourceRoot, safeStorage);
  const target = makeManager(targetRoot, safeStorage);
  t.after(() => {
    try { source.getStorage().close(); } catch { /* ignore */ }
    try { target.getStorage().close(); } catch { /* ignore */ }
    for (const item of [sourceRoot, targetRoot, zipPath]) {
      try { fs.rmSync(item, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
    }
  });

  source.getStorage().configSet('theme', 'dark');
  source.getStorage().configSet('nova-model-registry', JSON.stringify({
    imageModels: [{ id: 'image-1', apiKey: 'must-not-export' }], textModels: [], defaults: {},
  }));
  source.getStorage().s3SaveSettings(JSON.stringify({
    endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'assets', rootPrefix: 'images', forcePathStyle: false,
  }), {
    accessKeyId: 's3-access-must-not-export', secretAccessKey: 's3-secret-must-not-export', sessionToken: 's3-token-must-not-export',
  });
  source.getStorage().recordPut('image-records', 'job-1', {
    id: 'job-1', images: ['IDB:job-1-0'], refImages: [], status: 'completed',
  });
  source.getStorage().files.write('history', 'job-1-0', Buffer.from('image'), 'image/png');

  await source.backup.exportTo(zipPath);
  const directory = await unzipper.Open.file(zipPath);
  const localStorageEntry = directory.files.find(entry => entry.path === 'localStorage.json');
  const localStorageJson = (await localStorageEntry.buffer()).toString('utf8');
  assert.equal(localStorageJson.includes('must-not-export'), false);
  assert.equal(localStorageJson.includes('s3-access-must-not-export'), false);
  assert.equal(localStorageJson.includes('s3-secret-must-not-export'), false);
  assert.equal(localStorageJson.includes('s3-token-must-not-export'), false);
  assert.equal(localStorageJson.includes('https://s3.example.com'), true);

  await target.backup.importFrom(zipPath);
  assert.equal(target.getStorage().configGet('theme'), 'dark');
  assert.equal(JSON.parse(target.getStorage().configGet('nova-model-registry')).imageModels[0].apiKey, '');
  assert.equal(target.getStorage().files.read('history', 'job-1-0').data.toString(), 'image');
  assert.equal(JSON.parse(target.getStorage().configGet('nova-s3-settings')).bucket, 'assets');
  assert.deepEqual(target.getStorage().s3GetCredentials(), { accessKeyId: '', secretAccessKey: '', sessionToken: '' });
});

test('imports plaintext secrets from a Web backup and encrypts them immediately', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-backup-secret-'));
  const zipPath = path.join(os.tmpdir(), `nova-web-backup-${Date.now()}.zip`);
  const manager = makeManager(root, makeSafeStorage());
  t.after(() => {
    try { manager.getStorage().close(); } catch { /* ignore */ }
    for (const item of [root, zipPath]) {
      try { fs.rmSync(item, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
    }
  });
  writeZip(zipPath, {
    'metadata.json': JSON.stringify({ version: '3.1.3' }),
    'localStorage.json': JSON.stringify({
      'nova-model-registry': JSON.stringify({
        imageModels: [{ id: 'image-1', apiKey: 'legacy-secret' }], textModels: [], defaults: {},
      }),
    }),
  });

  await manager.backup.importFrom(zipPath);
  const raw = manager.getStorage().db.prepare("SELECT value_json FROM app_settings WHERE storage_key = 'nova-model-registry'").get().value_json;
  assert.equal(raw.includes('legacy-secret'), false);
  assert.equal(JSON.parse(manager.getStorage().configGet('nova-model-registry')).imageModels[0].apiKey, 'legacy-secret');
});

test('imports the nested localforage layout written by Web backups', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-web-canvas-'));
  const zipPath = path.join(os.tmpdir(), `nova-web-canvas-${Date.now()}.zip`);
  const manager = makeManager(root, makeSafeStorage());
  t.after(() => {
    try { manager.getStorage().close(); } catch { /* ignore */ }
    for (const item of [root, zipPath]) {
      try { fs.rmSync(item, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
    }
  });
  writeZip(zipPath, {
    'metadata.json': JSON.stringify({ version: '3.1.3' }),
    'localforage/nova-image.json': JSON.stringify({
      'nova-image': {
        canvas_app_state: [{ key: 'canvas', value: '{"nodes":[]}' }],
        canvas_image_files: [{ key: 'image:canvas-1', _blobRef: 'canvas-1', _blobMimeType: 'image/png' }],
      },
    }),
    'blobs/canvas-1': Buffer.from('canvas-image'),
  });

  await manager.backup.importFrom(zipPath);
  assert.equal(manager.getStorage().recordGet('canvas-state', 'canvas'), '{"nodes":[]}');
  assert.equal(manager.getStorage().files.read('canvas', 'image:canvas-1').data.toString(), 'canvas-image');
});

test('rejects unsafe paths and preserves current data when a referenced blob is missing', async t => {
  assert.throws(() => safeEntryPath('../outside'), /不安全路径/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-backup-rollback-'));
  const zipPath = path.join(os.tmpdir(), `nova-broken-backup-${Date.now()}.zip`);
  const manager = makeManager(root, makeSafeStorage());
  t.after(() => {
    try { manager.getStorage().close(); } catch { /* ignore */ }
    for (const item of [root, zipPath]) {
      try { fs.rmSync(item, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
    }
  });
  manager.getStorage().configSet('theme', 'light');
  writeZip(zipPath, {
    'metadata.json': JSON.stringify({ version: '3.1.3' }),
    'indexedDB/nova-image-db.json': JSON.stringify({
      images: [],
      blobs: [{ key: 'job-1-0', blob: { _blobRef: 'missing', _blobMimeType: 'image/png' } }],
    }),
  });

  await assert.rejects(manager.backup.importFrom(zipPath), /缺少二进制文件/);
  assert.equal(manager.getStorage().configGet('theme'), 'light');
});
