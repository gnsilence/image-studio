const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { StorageService } = require('./storage/storage-service');
const {
  S3Service,
  normalizeConfig,
  validatePrefix,
} = require('./s3-service');

function makeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: value => value.toString('utf8').replace(/^encrypted:/, ''),
  };
}

function withStorage(t) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-s3-test-'));
  const storage = new StorageService({ dataRoot, safeStorage: makeSafeStorage() });
  t.after(() => {
    storage.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  return storage;
}

function saveTestConfig(storage) {
  storage.s3SaveSettings(JSON.stringify({
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'nova-assets',
    rootPrefix: 'images',
    forcePathStyle: true,
  }), {
    accessKeyId: 'test-access',
    secretAccessKey: 'test-secret',
    sessionToken: 'test-token',
  });
}

function makeService(storage, handler, overrides = {}) {
  return new S3Service({
    getStorage: () => storage,
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    getWindow: () => null,
    clientFactory: options => ({
      options,
      send: handler,
      destroy() {},
    }),
    ...overrides,
  });
}

test('S3 config only allows HTTPS or loopback HTTP and confines prefixes', () => {
  assert.equal(normalizeConfig({ endpoint: 'https://r2.example.com', region: 'auto', bucket: 'assets' }).endpoint, 'https://r2.example.com');
  assert.equal(normalizeConfig({ endpoint: 'http://127.0.0.1:9000', region: 'local', bucket: 'assets' }).endpoint, 'http://127.0.0.1:9000');
  assert.throws(() => normalizeConfig({ endpoint: 'http://192.168.1.8:9000', region: 'local', bucket: 'assets' }), /仅允许本机地址/);
  const config = normalizeConfig({ endpoint: '', region: 'us-east-1', bucket: 'assets', rootPrefix: 'images/shared' });
  assert.equal(validatePrefix('', config), 'images/shared/');
  assert.equal(validatePrefix('images/shared/team/', config), 'images/shared/team/');
  assert.throws(() => validatePrefix('images/private/', config), /超出/);
  assert.throws(() => validatePrefix('images/shared/../private/', config), /无效目录段/);
});

test('S3 credentials are encrypted and never returned by public config', t => {
  const storage = withStorage(t);
  const service = makeService(storage, async () => ({}));
  const config = service.saveConfig({
    config: { endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'assets', rootPrefix: '', forcePathStyle: false },
    credentials: { accessKeyId: 'plain-access', secretAccessKey: 'plain-secret', sessionToken: 'plain-token' },
  });
  assert.equal(config.hasAccessKeyId, true);
  assert.equal(Object.hasOwn(config, 'accessKeyId'), false);
  const ciphertext = storage.db.prepare('SELECT ciphertext FROM app_secrets ORDER BY storage_key').all()
    .map(row => Buffer.from(row.ciphertext).toString('utf8'));
  assert.equal(ciphertext.every(value => value.startsWith('encrypted:')), true);
  assert.equal(ciphertext.includes('plain-access'), false);
  assert.equal(ciphertext.includes('plain-secret'), false);
  assert.equal(ciphertext.includes('plain-token'), false);
});

test('blank credential fields preserve saved values and key pairs update together', t => {
  const storage = withStorage(t);
  const service = makeService(storage, async () => ({}));
  service.saveConfig({
    config: { endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'assets', rootPrefix: '', forcePathStyle: false },
    credentials: { accessKeyId: 'first-access', secretAccessKey: 'first-secret', sessionToken: 'first-token' },
  });
  service.saveConfig({
    config: { endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'assets-2', rootPrefix: 'images', forcePathStyle: false },
    credentials: { accessKeyId: '', secretAccessKey: '', sessionToken: '' },
  });
  assert.deepEqual(storage.s3GetCredentials(), {
    accessKeyId: 'first-access', secretAccessKey: 'first-secret', sessionToken: 'first-token',
  });
  assert.throws(() => service.saveConfig({
    config: { endpoint: '', region: 'us-east-1', bucket: 'assets', rootPrefix: '', forcePathStyle: false },
    credentials: { accessKeyId: 'replacement', secretAccessKey: '' },
  }), /必须同时填写/);
});

test('S3 settings roll back when system encryption is unavailable', t => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-s3-encryption-test-'));
  const storage = new StorageService({
    dataRoot,
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error('must not encrypt'); },
      decryptString: () => { throw new Error('must not decrypt'); },
    },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  const service = makeService(storage, async () => ({}));
  assert.throws(() => service.saveConfig({
    config: { endpoint: '', region: 'us-east-1', bucket: 'assets', rootPrefix: '', forcePathStyle: false },
    credentials: { accessKeyId: 'plain-access', secretAccessKey: 'plain-secret' },
  }), /敏感凭据未保存/);
  assert.equal(storage.configGet('nova-s3-settings'), null);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM app_secrets WHERE storage_key LIKE 's3:%'").get().count, 0);
});

test('listFolder uses delimiter pagination and returns only supported direct images', async t => {
  const storage = withStorage(t);
  saveTestConfig(storage);
  let input;
  const service = makeService(storage, async command => {
    input = command.input;
    return {
      CommonPrefixes: [{ Prefix: 'images/a/' }, { Prefix: 'images/b/' }],
      Contents: [
        { Key: 'images/photo.png', Size: 12, ETag: 'etag-1', LastModified: new Date('2026-01-01') },
        { Key: 'images/readme.txt', Size: 4 },
        { Key: 'images/huge.jpg', Size: 101 * 1024 * 1024 },
        { Key: 'images/a/nested.jpg', Size: 8 },
      ],
      IsTruncated: true,
      NextContinuationToken: 'next-page',
    };
  });
  const result = await service.listFolder({ prefix: 'images/', continuationToken: 'page-1' });
  assert.equal(input.Delimiter, '/');
  assert.equal(input.MaxKeys, 100);
  assert.equal(input.ContinuationToken, 'page-1');
  assert.deepEqual(result.folders.map(folder => folder.name), ['a', 'b']);
  assert.deepEqual(result.objects.map(object => object.name), ['photo.png']);
  assert.equal(result.nextToken, 'next-page');
});

test('upload retries with a generated name when conditional write conflicts', async t => {
  const storage = withStorage(t);
  saveTestConfig(storage);
  const keys = [];
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const service = makeService(storage, async command => {
    keys.push(command.input.Key);
    if (keys.length === 1) {
      const error = new Error('conflict');
      error.$metadata = { httpStatusCode: 412 };
      throw error;
    }
    return { ETag: 'new-etag' };
  });
  const result = await service.uploadObject({ prefix: 'images/', fileName: 'sample.png', mimeType: 'image/png', data: png });
  assert.equal(keys[0], 'images/sample.png');
  assert.notEqual(keys[1], keys[0]);
  assert.match(result.name, /^sample-\d{14}-[a-f0-9]{4}\.png$/);
});

test('upload rejects unsupported or misleading file extensions', async t => {
  const storage = withStorage(t);
  saveTestConfig(storage);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const service = makeService(storage, async () => ({ ETag: 'new-etag' }));
  await assert.rejects(
    service.uploadObject({ prefix: 'images/', fileName: 'sample.bmp', mimeType: 'image/png', data: png }),
    /仅支持/,
  );
  await assert.rejects(
    service.uploadObject({ prefix: 'images/', fileName: 'sample.jpg', mimeType: 'image/jpeg', data: png }),
    /扩展名与实际图片格式不一致/,
  );
});

test('thumbnail cache is versioned and reused for the same object version', async t => {
  const storage = withStorage(t);
  saveTestConfig(storage);
  let downloads = 0;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const processor = () => ({
    rotate() { return this; },
    resize() { return this; },
    webp() { return this; },
    async toBuffer() { return Buffer.from('thumbnail'); },
  });
  const service = makeService(storage, async () => {
    downloads += 1;
    return { Body: png, ContentLength: png.length, ContentType: 'image/png' };
  }, { imageProcessor: processor });
  const object = { key: 'images/sample.png', name: 'sample.png', mimeType: 'image/png', sizeBytes: png.length, etag: 'v1' };
  const first = await service.readThumbnail(object);
  const second = await service.readThumbnail(object);
  await service.readThumbnail({ ...object, etag: 'v2' });
  assert.equal(first.data.toString(), 'thumbnail');
  assert.equal(second.data.toString(), 'thumbnail');
  assert.equal(downloads, 2);
});

test('cache cleanup removes only least-recently-used S3 entries', () => {
  const removed = [];
  const fakeStorage = {
    files: {
      list: () => [
        { id: 'upload:keep', sizeBytes: 2 * 1024 * 1024 * 1024, lastAccessedAt: '2025-01-01' },
        { id: 's3-thumb:old', sizeBytes: 700 * 1024 * 1024, lastAccessedAt: '2025-01-01' },
        { id: 's3-original:new', sizeBytes: 500 * 1024 * 1024, lastAccessedAt: '2026-01-01' },
      ],
      delete: (_namespace, id) => removed.push(id),
    },
  };
  const service = makeService(fakeStorage, async () => ({}));
  assert.equal(service.cleanupCache(), 1);
  assert.deepEqual(removed, ['s3-thumb:old']);
});
