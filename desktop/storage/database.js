const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial desktop storage',
    sql: `
      -- 表：记录已执行的桌面数据库迁移。
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, -- 字段：迁移版本号。
        name TEXT NOT NULL, -- 字段：迁移名称。
        applied_at TEXT NOT NULL -- 字段：迁移执行时间（ISO 8601）。
      );

      -- 表：保存不含密钥的应用配置。
      CREATE TABLE IF NOT EXISTS app_settings (
        namespace TEXT NOT NULL, -- 字段：配置所属命名空间。
        storage_key TEXT NOT NULL, -- 字段：配置键。
        value_json TEXT NOT NULL, -- 字段：JSON 编码后的配置值。
        updated_at TEXT NOT NULL, -- 字段：最后更新时间（ISO 8601）。
        PRIMARY KEY (namespace, storage_key)
      );

      -- 表：保存通过系统能力加密后的敏感配置。
      CREATE TABLE IF NOT EXISTS app_secrets (
        storage_key TEXT PRIMARY KEY, -- 字段：敏感配置键。
        ciphertext BLOB NOT NULL, -- 字段：系统加密后的密文。
        updated_at TEXT NOT NULL -- 字段：最后更新时间（ISO 8601）。
      );

      -- 表：保存历史、素材、Agent、反推和画布等结构化记录。
      CREATE TABLE IF NOT EXISTS app_records (
        namespace TEXT NOT NULL, -- 字段：记录所属业务命名空间。
        record_key TEXT NOT NULL, -- 字段：命名空间内唯一记录键。
        value_json TEXT NOT NULL, -- 字段：JSON 编码后的记录内容。
        created_at TEXT NOT NULL, -- 字段：首次创建时间（ISO 8601）。
        updated_at TEXT NOT NULL, -- 字段：最后更新时间（ISO 8601）。
        PRIMARY KEY (namespace, record_key)
      );

      -- 表：保存由主进程管理的本地文件元数据。
      CREATE TABLE IF NOT EXISTS stored_files (
        namespace TEXT NOT NULL, -- 字段：文件所属业务命名空间。
        id TEXT NOT NULL, -- 字段：命名空间内唯一文件标识。
        relative_path TEXT NOT NULL UNIQUE, -- 字段：相对文件根目录的受控路径。
        mime_type TEXT NOT NULL, -- 字段：文件 MIME 类型。
        size_bytes INTEGER NOT NULL, -- 字段：文件字节数。
        sha256 TEXT NOT NULL, -- 字段：文件内容 SHA-256。
        created_at TEXT NOT NULL, -- 字段：首次创建时间（ISO 8601）。
        updated_at TEXT NOT NULL, -- 字段：最后更新时间（ISO 8601）。
        last_accessed_at TEXT NOT NULL, -- 字段：最后读取时间（ISO 8601）。
        PRIMARY KEY (namespace, id)
      );

      CREATE INDEX IF NOT EXISTS idx_app_settings_namespace
        ON app_settings(namespace, updated_at);
      CREATE INDEX IF NOT EXISTS idx_app_records_namespace
        ON app_records(namespace, updated_at);
      CREATE INDEX IF NOT EXISTS idx_stored_files_namespace
        ON stored_files(namespace, last_accessed_at);
      CREATE INDEX IF NOT EXISTS idx_stored_files_sha256
        ON stored_files(sha256);
    `,
  },
];

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function currentVersion(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!table) return 0;
  return db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;
}

function backupBeforeMigration(db, dbPath, version) {
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0 || version >= MIGRATIONS.at(-1).version) return null;
  db.pragma('wal_checkpoint(TRUNCATE)');
  const backupPath = `${dbPath}.pre-migration-${Date.now()}`;
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

function applyMigrations(db) {
  const installed = currentVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= installed) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}

function openDesktopDatabase(dbPath) {
  ensureParentDirectory(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  const installed = currentVersion(db);
  const backupPath = backupBeforeMigration(db, dbPath, installed);
  try {
    applyMigrations(db);
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new Error(`SQLite quick_check failed: ${check}`);
  } catch (error) {
    try { db.close(); } catch { /* ignore */ }
    if (backupPath) fs.copyFileSync(backupPath, dbPath);
    throw error;
  }
  return db;
}

module.exports = { MIGRATIONS, openDesktopDatabase };
