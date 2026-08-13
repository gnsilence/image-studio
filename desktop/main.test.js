const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('desktop main keeps tray icon assets available', () => {
  const icoPath = path.join(__dirname, '..', 'frontend', 'public', 'app.ico');
  const pngPath = path.join(__dirname, '..', 'frontend', 'public', 'icon-192.png');
  assert.equal(fs.existsSync(icoPath), true);
  assert.equal(fs.existsSync(pngPath), true);
});
