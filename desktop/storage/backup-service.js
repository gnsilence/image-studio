const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ZipArchive } = require('archiver');
const unzipper = require('unzipper');
const { CONFIG_KEYS, StorageService } = require('./storage-service');

const MAX_EXPANDED_SIZE = 20 * 1024 * 1024 * 1024;
const MAX_JSON_SIZE = 512 * 1024 * 1024;

function jsonBuffer(value) {
  return Buffer.from(JSON.stringify(value));
}

function safeEntryPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`备份包含不安全路径: ${value}`);
  }
  return normalized;
}

function stripRegistrySecrets(raw) {
  if (!raw) return raw;
  const registry = JSON.parse(raw);
  for (const models of [registry.imageModels, registry.textModels]) {
    if (!Array.isArray(models)) continue;
    for (const model of models) if (model && typeof model === 'object') model.apiKey = '';
  }
  return JSON.stringify(registry);
}

function bufferToDataUrl(buffer, mimeType) {
  return `data:${mimeType || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
}

function dataUrlToBuffer(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''));
  if (!match) return null;
  return {
    mimeType: match[1] || 'application/octet-stream',
    data: match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3])),
  };
}

function parseImageFileId(id) {
  const separator = id.lastIndexOf('-');
  if (separator <= 0) return null;
  const imageIndex = Number(id.slice(separator + 1));
  if (!Number.isInteger(imageIndex) || imageIndex < 0) return null;
  return { jobId: id.slice(0, separator), imageIndex };
}

class ZipWriter {
  constructor(filePath) {
    this.output = fs.createWriteStream(filePath);
    this.archive = new ZipArchive({ zlib: { level: 6 } });
    this.done = new Promise((resolve, reject) => {
      this.output.once('close', resolve);
      this.output.once('error', reject);
      this.archive.once('error', reject);
    });
    this.archive.pipe(this.output);
  }

  addJson(entryPath, value) {
    this.archive.append(jsonBuffer(value), { name: safeEntryPath(entryPath) });
  }

  addFile(entryPath, filePath) {
    this.archive.file(filePath, { name: safeEntryPath(entryPath) });
  }

  async finalize() {
    await this.archive.finalize();
    await this.done;
  }
}

class BackupService {
  constructor({ dataRoot, safeStorage, getStorage, replaceStorage, appVersion }) {
    this.dataRoot = dataRoot;
    this.safeStorage = safeStorage;
    this.getStorage = getStorage;
    this.replaceStorage = replaceStorage;
    this.appVersion = appVersion;
  }

  defaultFileName() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `aioss-image-backup-${stamp}.zip`;
  }

  async exportTo(filePath) {
    const storage = this.getStorage();
    const writer = new ZipWriter(filePath);
    let blobSequence = 0;
    const addStoredBlob = (namespace, id) => {
      const row = storage.db.prepare(`
        SELECT relative_path, mime_type FROM stored_files WHERE namespace = ? AND id = ?
      `).get(namespace, id);
      if (!row) return null;
      const blobRef = `desktop_${++blobSequence}`;
      writer.addFile(`blobs/${blobRef}`, storage.files.resolveRelative(row.relative_path));
      return { _blobRef: blobRef, _blobMimeType: row.mime_type };
    };

    const localStorageData = {};
    for (const key of CONFIG_KEYS) {
      const value = storage.configGet(key);
      if (value === null) continue;
      localStorageData[key] = key === 'nova-model-registry' ? stripRegistrySecrets(value) : value;
    }

    const imageRecords = storage.recordList('image-records').map(entry => ({ ...entry.value }));
    for (const record of imageRecords) {
      if (!Array.isArray(record.refImages)) continue;
      for (let index = 0; index < record.refImages.length; index++) {
        if (record.refImages[index]?.dataUrl) continue;
        const stored = storage.files.read('history', `${record.id}:ref:${index}`);
        if (stored) record.refImages[index] = { ...record.refImages[index], dataUrl: bufferToDataUrl(stored.data, stored.mimeType) };
      }
    }

    const imageBlobs = [];
    for (const file of storage.files.list('history')) {
      const parsed = parseImageFileId(file.id);
      if (!parsed) continue;
      const blob = addStoredBlob('history', file.id);
      if (blob) imageBlobs.push({ key: file.id, ...parsed, blob, createdAt: Date.now() });
    }
    for (const file of storage.files.list('agent')) {
      const blob = addStoredBlob('agent', file.id);
      if (blob) imageBlobs.push({ key: `${file.id}-0`, jobId: file.id, imageIndex: 0, blob, createdAt: Date.now() });
    }

    const reverseRecords = storage.recordList('reverse-results').map(entry => ({ ...entry.value }));
    const draft = reverseRecords.find(record => record.slot === 'draft');
    if (draft?.file && !draft.file.dataUrl) {
      const stored = storage.files.read('cache', 'reverse-draft');
      if (stored) {
        const dataUrl = bufferToDataUrl(stored.data, stored.mimeType);
        draft.file = { ...draft.file, dataUrl, preview: dataUrl };
      }
    }

    const uploadRecords = [];
    for (const entry of storage.recordList('upload-cache')) {
      const record = { ...entry.value };
      if (!record.dataUrl) {
        const stored = storage.files.read('cache', `upload:${entry.key}`);
        if (stored) record.dataUrl = bufferToDataUrl(stored.data, stored.mimeType);
      }
      uploadRecords.push(record);
    }

    const agentMeta = storage.recordList('agent-meta').map(entry => ({
      key: entry.key,
      value: typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value),
    }));
    const assets = storage.recordList('assets').map(entry => entry.value);
    const assetBlobs = [];
    const assetHashes = new Set(assets.filter(asset => asset?.kind !== 'text').map(asset => asset.blobKey));
    for (const hash of assetHashes) {
      const blob = addStoredBlob('assets', `blob:${hash}`);
      if (!blob) continue;
      const thumbnailBlob = addStoredBlob('assets', `thumb:${hash}`);
      const source = assets.find(asset => asset.blobKey === hash) || {};
      assetBlobs.push({
        key: hash, hash, blob, ...(thumbnailBlob ? { thumbnailBlob } : {}),
        mimeType: source.mimeType || 'image/png', sizeBytes: source.sizeBytes || 0,
        width: source.width, height: source.height, createdAt: source.createdAt || Date.now(),
      });
    }

    const canvasState = storage.recordList('canvas-state').map(entry => ({ key: entry.key, value: entry.value }));
    const canvasFiles = storage.files.list('canvas').flatMap(file => {
      const blob = addStoredBlob('canvas', file.id);
      return blob ? [{ key: file.id, ...blob }] : [];
    });

    writer.addJson('metadata.json', {
      version: this.appVersion,
      formatVersion: 2,
      platform: 'electron',
      exportDate: new Date().toISOString(),
      appName: 'AIOSS Image',
      secretsIncluded: false,
    });
    writer.addJson('localStorage.json', localStorageData);
    writer.addJson('indexedDB/nova-image-db.json', { images: imageRecords, blobs: imageBlobs });
    writer.addJson('indexedDB/nova-reverse-db.json', { 'reverse-results': reverseRecords });
    writer.addJson('indexedDB/nova-upload-cache.json', { images: uploadRecords });
    writer.addJson('indexedDB/nova-agent-db.json', {
      messages: storage.recordList('agent-messages').map(entry => entry.value),
      images: storage.recordList('agent-images').map(entry => entry.value),
      meta: agentMeta,
    });
    writer.addJson('indexedDB/nova-assets-db.json', { assets, 'asset-blobs': assetBlobs });
    writer.addJson('localforage/nova-image.json', {
      canvas_app_state: canvasState,
      canvas_image_files: canvasFiles,
    });
    await writer.finalize();
  }

  async openArchive(filePath) {
    const directory = await unzipper.Open.file(filePath);
    let expandedSize = 0;
    const entries = new Map();
    for (const entry of directory.files) {
      const entryPath = safeEntryPath(entry.path);
      expandedSize += Number(entry.vars?.uncompressedSize || 0);
      if (expandedSize > MAX_EXPANDED_SIZE) throw new Error('备份解压后超过 20 GB 限制');
      if (entries.has(entryPath)) throw new Error(`备份包含重复路径: ${entryPath}`);
      entries.set(entryPath, entry);
    }
    return entries;
  }

  async readJson(entries, entryPath, fallback = null) {
    const entry = entries.get(entryPath);
    if (!entry) return fallback;
    if (Number(entry.vars?.uncompressedSize || 0) > MAX_JSON_SIZE) throw new Error(`${entryPath} 超过 JSON 大小限制`);
    return JSON.parse((await entry.buffer()).toString('utf8'));
  }

  async readBlob(entries, value) {
    if (value && typeof value === 'object' && typeof value._blobRef === 'string') {
      const entry = entries.get(`blobs/${value._blobRef}`);
      if (!entry) throw new Error(`备份缺少二进制文件: ${value._blobRef}`);
      return { data: await entry.buffer(), mimeType: value._blobMimeType || 'application/octet-stream' };
    }
    if (typeof value === 'string') return { data: Buffer.from(value, 'base64'), mimeType: 'application/octet-stream' };
    return null;
  }

  async populateStorage(storage, entries) {
    const metadata = await this.readJson(entries, 'metadata.json', {});
    if (metadata?.incremental === true) throw new Error('不支持导入非完整备份文件');
    const localStorageData = await this.readJson(entries, 'localStorage.json', {});
    for (const [key, value] of Object.entries(localStorageData || {})) {
      if (!CONFIG_KEYS.has(key) || typeof value !== 'string') continue;
      storage.configSet(key, value);
    }

    const imageDb = await this.readJson(entries, 'indexedDB/nova-image-db.json', {});
    for (const record of imageDb?.images || []) {
      if (record?.id) storage.recordPut('image-records', String(record.id), record);
    }
    for (const record of imageDb?.blobs || []) {
      if (!record?.key) continue;
      const blob = await this.readBlob(entries, record.blob);
      if (blob) storage.files.write('history', String(record.key), blob.data, blob.mimeType);
    }

    const reverseDb = await this.readJson(entries, 'indexedDB/nova-reverse-db.json', {});
    for (const record of reverseDb?.['reverse-results'] || []) {
      if (!record?.slot) continue;
      if (record.slot === 'draft' && record.file?.dataUrl) {
        const blob = dataUrlToBuffer(record.file.dataUrl);
        if (blob) {
          storage.files.write('cache', 'reverse-draft', blob.data, blob.mimeType);
          record.file = { ...record.file, dataUrl: '', preview: '' };
        }
      }
      storage.recordPut('reverse-results', String(record.slot), record);
    }

    const uploadDb = await this.readJson(entries, 'indexedDB/nova-upload-cache.json', {});
    for (const record of uploadDb?.images || []) {
      if (!record?.key) continue;
      const blob = dataUrlToBuffer(record.dataUrl);
      if (blob) storage.files.write('cache', `upload:${record.key}`, blob.data, blob.mimeType);
      storage.recordPut('upload-cache', String(record.key), { ...record, dataUrl: '' });
    }

    const agentDb = await this.readJson(entries, 'indexedDB/nova-agent-db.json', {});
    for (const record of agentDb?.messages || []) if (record?.id) storage.recordPut('agent-messages', String(record.id), record);
    for (const record of agentDb?.images || []) {
      if (!record?.imgId) continue;
      storage.recordPut('agent-images', String(record.imgId), record);
      const legacy = storage.files.read('history', `${record.imgId}-0`);
      if (legacy) {
        storage.files.write('agent', String(record.imgId), legacy.data, legacy.mimeType);
        storage.files.delete('history', `${record.imgId}-0`);
      }
    }
    for (const record of agentDb?.meta || []) {
      if (!record?.key) continue;
      let value = record.value;
      if (record.key !== 'imageModel' && typeof value === 'string') {
        try { value = JSON.parse(value); } catch { /* keep original */ }
      }
      storage.recordPut('agent-meta', String(record.key), value);
    }

    const assetsDb = await this.readJson(entries, 'indexedDB/nova-assets-db.json', {});
    for (const record of assetsDb?.assets || []) if (record?.id) storage.recordPut('assets', String(record.id), record);
    for (const record of assetsDb?.['asset-blobs'] || []) {
      if (!record?.key) continue;
      const blob = await this.readBlob(entries, record.blob);
      if (blob) storage.files.write('assets', `blob:${record.key}`, blob.data, record.mimeType || blob.mimeType);
      const thumbnail = await this.readBlob(entries, record.thumbnailBlob);
      if (thumbnail) storage.files.write('assets', `thumb:${record.key}`, thumbnail.data, thumbnail.mimeType);
    }

    const localForagePayload = await this.readJson(entries, 'localforage/nova-image.json', {});
    // Web exports nest the two localforage stores beneath the database name;
    // desktop exports keep the same stores at the top level for compatibility.
    const localForage = localForagePayload?.['nova-image'] || localForagePayload;
    for (const record of localForage?.canvas_app_state || []) {
      if (record?.key && typeof record.value === 'string') storage.recordPut('canvas-state', String(record.key), record.value);
    }
    for (const record of localForage?.canvas_image_files || []) {
      if (!record?.key) continue;
      const blob = await this.readBlob(entries, record);
      if (blob) storage.files.write('canvas', String(record.key), blob.data, blob.mimeType);
    }
  }

  async importFrom(filePath) {
    const entries = await this.openArchive(filePath);
    const stagingRoot = path.join(this.dataRoot, `.import-${randomUUID()}`);
    const rollbackRoot = path.join(this.dataRoot, `.rollback-${randomUUID()}`);
    const stagingStorage = new StorageService({ dataRoot: stagingRoot, safeStorage: this.safeStorage });
    try {
      await this.populateStorage(stagingStorage, entries);
      if (stagingStorage.db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('导入后的 SQLite 校验失败');
      stagingStorage.close();
      await this.swapStorage(stagingRoot, rollbackRoot);
    } catch (error) {
      try { stagingStorage.close(); } catch { /* ignore */ }
      fs.rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      throw error;
    }
  }

  async swapStorage(stagingRoot, rollbackRoot) {
    const current = this.getStorage();
    const currentDb = current.dbPath;
    const currentFiles = current.filesPath;
    const stagedDb = path.join(stagingRoot, 'data', 'app.sqlite');
    const stagedFiles = path.join(stagingRoot, 'files');
    const rollbackDb = path.join(rollbackRoot, 'app.sqlite');
    const rollbackFiles = path.join(rollbackRoot, 'files');
    fs.mkdirSync(rollbackRoot, { recursive: true });
    current.close();
    try {
      for (const suffix of ['-wal', '-shm']) fs.rmSync(`${currentDb}${suffix}`, { force: true });
      if (fs.existsSync(currentDb)) fs.renameSync(currentDb, rollbackDb);
      if (fs.existsSync(currentFiles)) fs.renameSync(currentFiles, rollbackFiles);
      fs.renameSync(stagedDb, currentDb);
      fs.renameSync(stagedFiles, currentFiles);
      const replacement = new StorageService({ dataRoot: this.dataRoot, safeStorage: this.safeStorage });
      this.replaceStorage(replacement);
      fs.rmSync(rollbackRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      try { fs.rmSync(currentDb, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(currentFiles, { recursive: true, force: true }); } catch { /* ignore */ }
      if (fs.existsSync(rollbackDb)) fs.renameSync(rollbackDb, currentDb);
      if (fs.existsSync(rollbackFiles)) fs.renameSync(rollbackFiles, currentFiles);
      this.replaceStorage(new StorageService({ dataRoot: this.dataRoot, safeStorage: this.safeStorage }));
      throw error;
    }
  }
}

module.exports = { BackupService, MAX_EXPANDED_SIZE, safeEntryPath, stripRegistrySecrets };
