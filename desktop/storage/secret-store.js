class SecretStore {
  constructor(db, safeStorage) {
    this.db = db;
    this.safeStorage = safeStorage;
    this.getStatement = db.prepare('SELECT ciphertext FROM app_secrets WHERE storage_key = ?');
    this.setStatement = db.prepare(`
      INSERT INTO app_secrets (storage_key, ciphertext, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(storage_key) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        updated_at = excluded.updated_at
    `);
    this.deleteStatement = db.prepare('DELETE FROM app_secrets WHERE storage_key = ?');
  }

  ensureAvailable() {
    if (!this.safeStorage || !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('系统密钥加密不可用，敏感凭据未保存');
    }
  }

  get(key) {
    const row = this.getStatement.get(key);
    if (!row) return '';
    this.ensureAvailable();
    return this.safeStorage.decryptString(Buffer.from(row.ciphertext));
  }

  set(key, value) {
    if (!value) {
      this.delete(key);
      return;
    }
    this.ensureAvailable();
    const encrypted = this.safeStorage.encryptString(value);
    this.setStatement.run(key, encrypted, new Date().toISOString());
  }

  delete(key) {
    this.deleteStatement.run(key);
  }
}

module.exports = { SecretStore };
