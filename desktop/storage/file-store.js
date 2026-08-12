const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FILE_NAMESPACES = new Set(['history', 'assets', 'agent', 'canvas', 'cache']);
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,240}$/;

function extensionFor(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('jpeg')) return '.jpg';
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.includes('gif')) return '.gif';
  if (normalized.includes('avif')) return '.avif';
  return '.bin';
}

class FileStore {
  constructor(db, rootPath) {
    this.db = db;
    this.rootPath = path.resolve(rootPath);
    fs.mkdirSync(this.rootPath, { recursive: true });
    for (const namespace of FILE_NAMESPACES) fs.mkdirSync(path.join(this.rootPath, namespace), { recursive: true });
  }

  validate(namespace, id) {
    if (!FILE_NAMESPACES.has(namespace)) throw new Error(`Unsupported file namespace: ${namespace}`);
    if (!ID_PATTERN.test(id)) throw new Error('Invalid file id');
  }

  resolveRelative(relativePath) {
    const resolved = path.resolve(this.rootPath, relativePath);
    const prefix = `${this.rootPath}${path.sep}`;
    if (!resolved.startsWith(prefix)) throw new Error('Stored file path escapes the data directory');
    return resolved;
  }

  write(namespace, id, data, mimeType = 'application/octet-stream') {
    this.validate(namespace, id);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const idHash = createHash('sha256').update(`${namespace}\0${id}`).digest('hex');
    const relativePath = path.join(namespace, `${idHash}-${sha256.slice(0, 16)}${extensionFor(mimeType)}`);
    const finalPath = this.resolveRelative(relativePath);
    const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
    const previous = this.db.prepare('SELECT relative_path FROM stored_files WHERE namespace = ? AND id = ?').get(namespace, id);
    const now = new Date().toISOString();
    const finalAlreadyExists = fs.existsSync(finalPath);

    if (!finalAlreadyExists) fs.writeFileSync(tempPath, buffer, { flag: 'wx' });
    try {
      if (!finalAlreadyExists) fs.renameSync(tempPath, finalPath);
      this.db.prepare(`
        INSERT INTO stored_files (
          namespace, id, relative_path, mime_type, size_bytes, sha256,
          created_at, updated_at, last_accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(namespace, id) DO UPDATE SET
          relative_path = excluded.relative_path,
          mime_type = excluded.mime_type,
          size_bytes = excluded.size_bytes,
          sha256 = excluded.sha256,
          updated_at = excluded.updated_at,
          last_accessed_at = excluded.last_accessed_at
      `).run(namespace, id, relativePath, mimeType, buffer.length, sha256, now, now, now);
    } catch (error) {
      try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
      if (!finalAlreadyExists) {
        try { fs.rmSync(finalPath, { force: true }); } catch { /* ignore */ }
      }
      throw error;
    }

    if (previous?.relative_path && previous.relative_path !== relativePath) {
      try { fs.rmSync(this.resolveRelative(previous.relative_path), { force: true }); } catch { /* ignore */ }
    }
    return { id, namespace, mimeType, sizeBytes: buffer.length, sha256 };
  }

  read(namespace, id) {
    this.validate(namespace, id);
    const row = this.db.prepare(`
      SELECT relative_path, mime_type, size_bytes, sha256
      FROM stored_files WHERE namespace = ? AND id = ?
    `).get(namespace, id);
    if (!row) return null;
    const filePath = this.resolveRelative(row.relative_path);
    if (!fs.existsSync(filePath)) return null;
    this.db.prepare('UPDATE stored_files SET last_accessed_at = ? WHERE namespace = ? AND id = ?')
      .run(new Date().toISOString(), namespace, id);
    return {
      id,
      namespace,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      data: fs.readFileSync(filePath),
    };
  }

  list(namespace) {
    if (!FILE_NAMESPACES.has(namespace)) throw new Error(`Unsupported file namespace: ${namespace}`);
    return this.db.prepare(`
      SELECT id, mime_type, size_bytes, sha256, created_at, updated_at, last_accessed_at
      FROM stored_files WHERE namespace = ? ORDER BY updated_at DESC
    `).all(namespace).map(row => ({
      id: row.id,
      namespace,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at,
    }));
  }

  delete(namespace, id) {
    this.validate(namespace, id);
    const row = this.db.prepare('SELECT relative_path FROM stored_files WHERE namespace = ? AND id = ?').get(namespace, id);
    this.db.prepare('DELETE FROM stored_files WHERE namespace = ? AND id = ?').run(namespace, id);
    if (row?.relative_path) {
      try { fs.rmSync(this.resolveRelative(row.relative_path), { force: true }); } catch { /* ignore */ }
    }
  }

  cleanup() {
    const referenced = new Set(this.db.prepare('SELECT relative_path FROM stored_files').all().map(row => path.normalize(row.relative_path)));
    let removed = 0;
    for (const namespace of FILE_NAMESPACES) {
      const directory = path.join(this.rootPath, namespace);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const relativePath = path.join(namespace, entry.name);
        if (entry.name.includes('.tmp-') || !referenced.has(path.normalize(relativePath))) {
          fs.rmSync(path.join(directory, entry.name), { force: true });
          removed += 1;
        }
      }
    }
    return removed;
  }
}

module.exports = { FILE_NAMESPACES, FileStore };
