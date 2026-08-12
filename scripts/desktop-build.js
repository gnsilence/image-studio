const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const mode = process.argv.includes('--dist') ? 'dist' : 'dir';
const requestedPlatform = process.argv.includes('--win')
  ? 'win32'
  : process.argv.includes('--mac')
    ? 'darwin'
    : process.platform;
const requestedArch = process.argv.includes('--arm64') ? 'arm64' : 'x64';
const configuredUpdateUrl = String(process.env.NOVA_UPDATE_URL || '').trim();

if (!['win32', 'darwin'].includes(requestedPlatform)) {
  throw new Error('Desktop packaging is supported only on Windows and macOS');
}

if (requestedPlatform !== process.platform) {
  throw new Error(
    `Cannot build ${requestedPlatform === 'darwin' ? 'macOS' : 'Windows'} installers on ${process.platform}. `
    + 'Native modules must be rebuilt on the target operating system.',
  );
}

if (mode === 'dist' && !/^https:\/\//i.test(configuredUpdateUrl)) {
  throw new Error('desktop:dist requires NOVA_UPDATE_URL to be a valid HTTPS URL');
}

const updateUrl = configuredUpdateUrl || 'https://updates.invalid/nova-image-studio';
const environment = {
  ...process.env,
  NODE_ENV: 'production',
  NOVA_DESKTOP_BUILD: '1',
  NOVA_UPDATE_URL: updateUrl,
};
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const commandOptions = {
  env: environment,
  stdio: 'inherit',
  ...(process.platform === 'win32' ? { shell: true } : {}),
};

function removePwaArtifacts(directory) {
  for (const fileName of fs.readdirSync(directory)) {
    if (fileName === 'sw.js' || /^workbox-.*\.js$/.test(fileName)) {
      fs.rmSync(path.join(directory, fileName), { force: true });
    }
  }
}

console.log('[desktop 1/2] Building static renderer without PWA...');
execFileSync(npmCommand, ['run', 'build'], {
  cwd: path.join(ROOT, 'frontend'),
  ...commandOptions,
});
removePwaArtifacts(path.join(ROOT, 'frontend', 'out'));

const platformLabel = requestedPlatform === 'darwin' ? 'macOS' : 'Windows';
const targetLabel = requestedPlatform === 'darwin' ? 'DMG/ZIP' : 'NSIS';
console.log(`[desktop 2/2] Building ${platformLabel} ${requestedArch} ${mode === 'dist' ? targetLabel : 'unpacked app'}...`);
const builderArgs = [
  'electron-builder',
  requestedPlatform === 'darwin' ? '--mac' : '--win',
  `--${requestedArch}`,
  '--config',
  'electron-builder.yml',
];
if (mode === 'dir') builderArgs.push('--dir');
if (process.env.NOVA_SKIP_NATIVE_REBUILD === '1') builderArgs.push('--config.npmRebuild=false');
execFileSync(npxCommand, builderArgs, {
  cwd: ROOT,
  ...commandOptions,
});
