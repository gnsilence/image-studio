const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const sharp = require('sharp');

const S3_CONFIG_KEY = 'nova-s3-settings';
const MAX_OBJECT_SIZE = 100 * 1024 * 1024;
const MAX_CACHE_SIZE = 1024 * 1024 * 1024;
const LIST_PAGE_SIZE = 100;
const THUMBNAIL_SIZE = 512;
const IMAGE_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.avif', 'image/avif'],
]);
const IMAGE_MIME_TYPES = new Set(IMAGE_EXTENSIONS.values());

const DEFAULT_CONFIG = Object.freeze({
  endpoint: '',
  region: 'us-east-1',
  bucket: '',
  rootPrefix: '',
  forcePathStyle: false,
});

function normalizeEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('S3 Endpoint 不是有效地址');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('S3 Endpoint 不能包含账号、查询参数或锚点');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('S3 Endpoint 只支持 HTTPS');
  }
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      throw new Error('HTTP S3 Endpoint 仅允许本机地址');
    }
  }
  return parsed.toString().replace(/\/$/, '');
}

function assertCleanSegments(value, label) {
  if (/[\\\0-\x1f\x7f]/.test(value)) throw new Error(`${label} 包含不支持的字符`);
  for (const segment of value.split('/')) {
    if (!segment || segment === '.' || segment === '..') throw new Error(`${label} 包含无效目录段`);
  }
}

function normalizeRootPrefix(value) {
  const raw = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  if (!raw) return '';
  assertCleanSegments(raw, '根前缀');
  if (Buffer.byteLength(raw, 'utf8') > 900) throw new Error('根前缀过长');
  return raw;
}

function normalizeConfig(input, requireComplete = true) {
  const config = {
    endpoint: normalizeEndpoint(input?.endpoint),
    region: String(input?.region || DEFAULT_CONFIG.region).trim(),
    bucket: String(input?.bucket || '').trim(),
    rootPrefix: normalizeRootPrefix(input?.rootPrefix),
    forcePathStyle: Boolean(input?.forcePathStyle),
  };
  if (!config.region || config.region.length > 100 || /\s/.test(config.region)) {
    throw new Error('S3 Region 无效');
  }
  if (requireComplete && (!config.bucket || config.bucket.length > 255 || /[\s/\\\0-\x1f]/.test(config.bucket))) {
    throw new Error('S3 Bucket 名称无效');
  }
  return config;
}

function rootPrefixFor(config) {
  return config.rootPrefix ? `${config.rootPrefix}/` : '';
}

function validatePrefix(value, config) {
  const root = rootPrefixFor(config);
  const raw = String(value || '').trim();
  if (!raw) return root;
  const normalized = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) return root;
  assertCleanSegments(normalized, '目录');
  const prefix = `${normalized}/`;
  if (root && prefix !== root && !prefix.startsWith(root)) throw new Error('目录超出已配置的 S3 根前缀');
  if (Buffer.byteLength(prefix, 'utf8') > 1024) throw new Error('S3 目录过长');
  return prefix;
}

function validateObjectKey(value, config) {
  const key = String(value || '');
  if (!key || key.endsWith('/') || key.startsWith('/')) throw new Error('S3 对象 Key 无效');
  assertCleanSegments(key, '对象 Key');
  const root = rootPrefixFor(config);
  if (root && !key.startsWith(root)) throw new Error('对象超出已配置的 S3 根前缀');
  if (Buffer.byteLength(key, 'utf8') > 1024) throw new Error('S3 对象 Key 过长');
  return key;
}

function validateFolderName(value) {
  const name = String(value || '').trim();
  if (!name || name === '.' || name === '..' || /[/\\\0-\x1f\x7f]/.test(name)) {
    throw new Error('文件夹名称无效');
  }
  if (Buffer.byteLength(name, 'utf8') > 200) throw new Error('文件夹名称过长');
  return name;
}

function validateFileName(value) {
  const name = String(value || '').trim();
  if (!name || name === '.' || name === '..' || /[/\\\0-\x1f\x7f]/.test(name)) {
    throw new Error('文件名无效');
  }
  if (Buffer.byteLength(name, 'utf8') > 240) throw new Error('文件名过长');
  return name;
}

function mimeForObject(key, contentType) {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  const extensionMime = IMAGE_EXTENSIONS.get(path.extname(key).toLowerCase());
  if (IMAGE_MIME_TYPES.has(normalized)) return normalized;
  return extensionMime || null;
}

function detectImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, Math.min(buffer.length, 32)).toString('ascii');
    if (brand.includes('avif') || brand.includes('avis')) return 'image/avif';
  }
  return null;
}

function objectName(key) {
  return key.slice(key.lastIndexOf('/') + 1);
}

function serializeDate(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isPreconditionFailure(error) {
  return error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412;
}

function mapS3Error(error) {
  if (error?.message?.startsWith('S3 ') || error?.message?.includes('根前缀') || error?.message?.includes('文件')) return error;
  const status = error?.$metadata?.httpStatusCode;
  const name = String(error?.name || '');
  if (status === 401 || status === 403 || ['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch'].includes(name)) {
    return new Error('S3 鉴权失败或当前凭据没有所需权限');
  }
  if (name === 'NoSuchBucket') return new Error('S3 存储桶不存在');
  if (name === 'NoSuchKey' || status === 404) return new Error('S3 图片不存在或已被移除');
  if (isPreconditionFailure(error)) return new Error('S3 图片已发生变化，请刷新目录后重试');
  if (['PermanentRedirect', 'AuthorizationHeaderMalformed', 'InvalidRegion'].includes(name)) {
    return new Error('S3 Region 或 Endpoint 配置不正确');
  }
  if (['TimeoutError', 'RequestTimeout', 'NetworkingError'].includes(name) || error?.code === 'ETIMEDOUT') {
    return new Error('连接 S3 超时，请检查网络和 Endpoint');
  }
  return new Error(`S3 操作失败${error?.message ? `：${error.message}` : ''}`);
}

async function bodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_OBJECT_SIZE) throw new Error('S3 图片超过 100 MB 限制');
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  }
  if (typeof body.transformToByteArray === 'function') {
    const bytes = await body.transformToByteArray();
    if (bytes.byteLength > MAX_OBJECT_SIZE) throw new Error('S3 图片超过 100 MB 限制');
    return Buffer.from(bytes);
  }
  throw new Error('S3 图片响应格式不受支持');
}

class S3Service {
  constructor({ getStorage, dialog, getWindow, clientFactory = options => new S3Client(options), imageProcessor = sharp }) {
    this.getStorage = getStorage;
    this.dialog = dialog;
    this.getWindow = getWindow;
    this.clientFactory = clientFactory;
    this.imageProcessor = imageProcessor;
    this.client = null;
    this.clientSignature = '';
  }

  storedConfig() {
    const raw = this.getStorage().configGet(S3_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    try {
      return normalizeConfig(JSON.parse(raw), false);
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  getConfig() {
    return {
      ...this.storedConfig(),
      ...this.getStorage().s3GetCredentialStatus(),
    };
  }

  resolveCredentials(input, requireComplete = true) {
    const stored = this.getStorage().s3GetCredentials();
    const accessKeyId = String(input?.accessKeyId || '').trim();
    const secretAccessKey = String(input?.secretAccessKey || '').trim();
    const sessionToken = String(input?.sessionToken || '').trim();
    if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) throw new Error('Access Key ID 和 Secret Access Key 必须同时填写');
    const credentials = accessKeyId && secretAccessKey
      ? { accessKeyId, secretAccessKey, sessionToken: sessionToken || stored.sessionToken || '' }
      : { ...stored, ...(sessionToken ? { sessionToken } : {}) };
    if (requireComplete && (!credentials.accessKeyId || !credentials.secretAccessKey)) {
      throw new Error('请先配置 S3 Access Key ID 和 Secret Access Key');
    }
    return credentials;
  }

  saveConfig(input) {
    const config = normalizeConfig(input?.config, true);
    const credentialInput = input?.credentials || {};
    const shouldUpdateCredentials = Boolean(
      String(credentialInput.accessKeyId || '').trim()
      || String(credentialInput.secretAccessKey || '').trim()
      || String(credentialInput.sessionToken || '').trim(),
    );
    const credentials = this.resolveCredentials(credentialInput, true);
    this.getStorage().s3SaveSettings(JSON.stringify(config), shouldUpdateCredentials ? credentials : null);
    this.invalidateClient();
    return this.getConfig();
  }

  clearCredentials() {
    this.getStorage().s3ClearCredentials();
    this.invalidateClient();
    return this.getConfig();
  }

  clientOptions(config, credentials) {
    return {
      region: config.region,
      endpoint: config.endpoint || undefined,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
      },
    };
  }

  getClient() {
    const config = normalizeConfig(this.storedConfig(), true);
    const credentials = this.resolveCredentials(null, true);
    const signature = createHash('sha256').update(JSON.stringify({ config, credentials })).digest('hex');
    if (this.client && this.clientSignature === signature) return { client: this.client, config };
    this.invalidateClient();
    this.client = this.clientFactory(this.clientOptions(config, credentials));
    this.clientSignature = signature;
    return { client: this.client, config };
  }

  invalidateClient() {
    try { this.client?.destroy?.(); } catch { /* ignore */ }
    this.client = null;
    this.clientSignature = '';
  }

  async testConnection(input) {
    const config = normalizeConfig(input?.config, true);
    const credentials = this.resolveCredentials(input?.credentials, true);
    const client = this.clientFactory(this.clientOptions(config, credentials));
    try {
      await client.send(new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: rootPrefixFor(config),
        Delimiter: '/',
        MaxKeys: 1,
      }));
      return { available: true, message: 'S3 读取连接正常' };
    } catch (error) {
      throw mapS3Error(error);
    } finally {
      try { client.destroy?.(); } catch { /* ignore */ }
    }
  }

  async listFolder(input = {}) {
    const { client, config } = this.getClient();
    const prefix = validatePrefix(input.prefix, config);
    const token = input.continuationToken ? String(input.continuationToken) : undefined;
    if (token && token.length > 8192) throw new Error('S3 分页令牌无效');
    try {
      const response = await client.send(new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: token,
        MaxKeys: LIST_PAGE_SIZE,
      }));
      const folders = (response.CommonPrefixes || []).flatMap(item => {
        try {
          const folderPrefix = validatePrefix(item.Prefix, config);
          const relative = folderPrefix.slice(prefix.length).replace(/\/$/, '');
          if (!relative || relative.includes('/')) return [];
          return [{ name: relative, prefix: folderPrefix }];
        } catch {
          return [];
        }
      });
      const objects = (response.Contents || []).flatMap(item => {
        try {
          const key = validateObjectKey(item.Key, config);
          if (key.slice(prefix.length).includes('/')) return [];
          const sizeBytes = Number(item.Size || 0);
          const mimeType = mimeForObject(key, undefined);
          if (!mimeType || sizeBytes <= 0 || sizeBytes > MAX_OBJECT_SIZE) return [];
          return [{
            key,
            name: objectName(key),
            mimeType,
            sizeBytes,
            etag: item.ETag || undefined,
            lastModified: serializeDate(item.LastModified),
          }];
        } catch {
          return [];
        }
      });
      return {
        prefix,
        folders,
        objects,
        nextToken: response.IsTruncated ? response.NextContinuationToken : undefined,
      };
    } catch (error) {
      throw mapS3Error(error);
    }
  }

  normalizeObject(input, config) {
    const key = validateObjectKey(input?.key, config);
    const sizeBytes = Number(input?.sizeBytes || 0);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_OBJECT_SIZE) {
      throw new Error('S3 图片大小无效或超过 100 MB 限制');
    }
    const mimeType = mimeForObject(key, input?.mimeType);
    if (!mimeType) throw new Error('S3 图片格式不受支持');
    return {
      key,
      name: validateFileName(input?.name || objectName(key)),
      mimeType,
      sizeBytes,
      etag: input?.etag ? String(input.etag) : undefined,
      lastModified: serializeDate(input?.lastModified),
    };
  }

  cacheId(kind, config, object) {
    const fingerprint = JSON.stringify({
      endpoint: config.endpoint || 'aws',
      region: config.region,
      bucket: config.bucket,
      key: object.key,
      version: object.etag || object.lastModified || object.sizeBytes,
      kind,
    });
    return `s3-${kind}:${createHash('sha256').update(fingerprint).digest('hex')}`;
  }

  async fetchObject(client, config, object) {
    try {
      const response = await client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: object.key,
        ...(object.etag ? { IfMatch: object.etag } : {}),
      }));
      if (Number(response.ContentLength || object.sizeBytes) > MAX_OBJECT_SIZE) throw new Error('S3 图片超过 100 MB 限制');
      const data = await bodyToBuffer(response.Body);
      const mimeType = detectImageMime(data);
      if (!mimeType) throw new Error('S3 对象不是受支持的图片格式');
      return { data, mimeType };
    } catch (error) {
      throw mapS3Error(error);
    }
  }

  async readObject(input) {
    const { client, config } = this.getClient();
    const object = this.normalizeObject(input, config);
    const cacheId = this.cacheId('original', config, object);
    const cached = this.getStorage().files.read('cache', cacheId);
    if (cached) return cached;
    const result = await this.fetchObject(client, config, object);
    const stored = this.getStorage().files.write('cache', cacheId, result.data, result.mimeType);
    this.cleanupCache();
    return { ...stored, data: result.data };
  }

  async readThumbnail(input) {
    const { client, config } = this.getClient();
    const object = this.normalizeObject(input, config);
    const cacheId = this.cacheId('thumb', config, object);
    const cached = this.getStorage().files.read('cache', cacheId);
    if (cached) return cached;
    const originalCacheId = this.cacheId('original', config, object);
    const original = this.getStorage().files.read('cache', originalCacheId)
      || await this.fetchObject(client, config, object);
    try {
      const thumbnail = await this.imageProcessor(original.data, { animated: false })
        .rotate()
        .resize({ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      const stored = this.getStorage().files.write('cache', cacheId, thumbnail, 'image/webp');
      this.cleanupCache();
      return { ...stored, data: thumbnail };
    } catch {
      throw new Error('S3 图片缩略图生成失败');
    }
  }

  cleanupCache() {
    const storage = this.getStorage();
    const files = storage.files.list('cache')
      .filter(file => file.id.startsWith('s3-thumb:') || file.id.startsWith('s3-original:'));
    let total = files.reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0);
    if (total <= MAX_CACHE_SIZE) return 0;
    let removed = 0;
    files.sort((a, b) => String(a.lastAccessedAt || '').localeCompare(String(b.lastAccessedAt || '')));
    for (const file of files) {
      if (total <= MAX_CACHE_SIZE) break;
      storage.files.delete('cache', file.id);
      total -= Number(file.sizeBytes || 0);
      removed += 1;
    }
    return removed;
  }

  async uploadObject(input) {
    const { client, config } = this.getClient();
    const prefix = validatePrefix(input?.prefix, config);
    const fileName = validateFileName(input?.fileName);
    const expectedMimeType = IMAGE_EXTENSIONS.get(path.extname(fileName).toLowerCase());
    if (!expectedMimeType) throw new Error('仅支持 PNG、JPEG、WebP、GIF 和 AVIF 图片');
    const data = Buffer.from(input?.data || []);
    if (!data.length || data.length > MAX_OBJECT_SIZE) throw new Error('上传图片大小无效或超过 100 MB 限制');
    const mimeType = detectImageMime(data);
    if (!mimeType) throw new Error('上传文件不是受支持的图片格式');
    if (mimeType !== expectedMimeType) throw new Error('上传文件扩展名与实际图片格式不一致');
    const extension = path.extname(fileName);
    const baseName = fileName.slice(0, fileName.length - extension.length) || 'image';
    const candidates = [fileName];
    for (let index = 0; index < 3; index++) {
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
      candidates.push(`${baseName}-${stamp}-${randomBytes(2).toString('hex')}${extension}`);
    }
    for (const candidate of candidates) {
      const key = validateObjectKey(`${prefix}${candidate}`, config);
      try {
        const response = await client.send(new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: data,
          ContentType: mimeType,
          IfNoneMatch: '*',
        }));
        return {
          key,
          name: candidate,
          mimeType,
          sizeBytes: data.length,
          etag: response.ETag || undefined,
          lastModified: new Date().toISOString(),
        };
      } catch (error) {
        if (isPreconditionFailure(error)) continue;
        throw mapS3Error(error);
      }
    }
    throw new Error('S3 中存在同名对象，自动重命名后仍然冲突');
  }

  async createFolder(input) {
    const { client, config } = this.getClient();
    const prefix = validatePrefix(input?.prefix, config);
    const name = validateFolderName(input?.name);
    const folderPrefix = validatePrefix(`${prefix}${name}/`, config);
    try {
      const existing = await client.send(new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: folderPrefix,
        MaxKeys: 1,
      }));
      if (Number(existing.KeyCount || 0) > 0 || (existing.Contents || []).length > 0) throw new Error('S3 文件夹已存在');
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: folderPrefix,
        Body: Buffer.alloc(0),
        ContentType: 'application/x-directory',
        IfNoneMatch: '*',
      }));
      return { name, prefix: folderPrefix };
    } catch (error) {
      if (error?.message === 'S3 文件夹已存在' || isPreconditionFailure(error)) throw new Error('S3 文件夹已存在');
      throw mapS3Error(error);
    }
  }

  async downloadObject(input) {
    const object = this.normalizeObject(input, normalizeConfig(this.storedConfig(), true));
    const target = await this.dialog.showSaveDialog(this.getWindow(), {
      title: '下载 S3 图片',
      defaultPath: object.name,
      filters: [{ name: '图片', extensions: [path.extname(object.name).replace(/^\./, '') || 'png'] }],
    });
    if (target.canceled || !target.filePath) return { canceled: true };
    const stored = await this.readObject(object);
    await fs.promises.writeFile(target.filePath, stored.data);
    return { canceled: false, filePath: target.filePath };
  }

  destroy() {
    this.invalidateClient();
  }
}

module.exports = {
  DEFAULT_CONFIG,
  LIST_PAGE_SIZE,
  MAX_CACHE_SIZE,
  MAX_OBJECT_SIZE,
  S3Service,
  detectImageMime,
  normalizeConfig,
  validatePrefix,
};
