const fs = require('node:fs/promises');
const path = require('node:path');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForWritable(filePath, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  await delay(1_500);
  while (Date.now() < deadline) {
    try {
      const handle = await fs.open(filePath, 'r+');
      await handle.close();
      await delay(250);
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`打包后的可执行文件持续被占用: ${filePath}`, { cause: lastError });
}

module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return;
  const executable = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  );
  await waitForWritable(executable);
};

module.exports.waitForWritable = waitForWritable;
