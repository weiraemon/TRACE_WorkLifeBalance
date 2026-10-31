import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

assert.ok(
  process.platform === 'win32' && process.arch === 'x64',
  'Build the desktop release on Windows x64.',
);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(project);
const output = path.join(project, '.desktop');
const cache = path.join(project, '.test-vault', 'desktop-runtimes');
await fs.mkdir(cache, { recursive: true });
await fs.mkdir(output, { recursive: true });
const runtimes = JSON.parse(await fs.readFile('scripts/desktop-runtimes.json', 'utf8'));
for (const runtime of Object.values(runtimes)) {
  const target = path.join(cache, runtime.file);
  let data = await fs.readFile(target).catch(() => undefined);
  if (!data) {
    console.log(`Downloading ${runtime.file}...`);
    const response = await fetch(runtime.url, { signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok, `Runtime download failed: ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
    assert.equal(
      createHash('sha256').update(data).digest('hex'),
      runtime.sha256,
      'Runtime checksum mismatch',
    );
    await fs.writeFile(target, data);
  }
  assert.equal(
    createHash('sha256').update(data).digest('hex'),
    runtime.sha256,
    'Cached runtime checksum mismatch',
  );
}
const pythonDir = path.join(output, 'runtime', 'python');
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath $env:CHAOS_PYTHON_ZIP -DestinationPath $env:CHAOS_PYTHON_DIR -Force
  Expand-Archive -LiteralPath $env:CHAOS_SQLCIPHER_WHEEL -DestinationPath (Join-Path $env:CHAOS_PYTHON_DIR 'Lib/site-packages') -Force`,
  ],
  {
    windowsHide: true,
    env: {
      ...process.env,
      CHAOS_PYTHON_ZIP: path.join(cache, runtimes.python.file),
      CHAOS_PYTHON_DIR: pythonDir,
      CHAOS_SQLCIPHER_WHEEL: path.join(cache, runtimes.sqlcipher.file),
    },
  },
);
await fs.writeFile(
  path.join(pythonDir, 'python312._pth'),
  'python312.zip\n.\nLib/site-packages\nimport site\n',
);
// Validate the actual native dependency, including loading SQLCipher's DLLs.
execFileSync(
  path.join(pythonDir, 'python.exe'),
  [
    '-c',
    "import sqlcipher3; c=sqlcipher3.connect(':memory:'); assert c.execute('PRAGMA cipher_version').fetchone()[0]; c.close()",
  ],
  { windowsHide: true },
);
await fs.cp('dist', path.join(output, 'dist'), { recursive: true });
await fs.mkdir(path.join(output, 'scripts'), { recursive: true });
for (const file of [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'setup-qq.cmd',
  'scripts/setup-qq.ps1',
  'scripts/qq_sync.py',
  'scripts/qq_probe.py',
]) {
  await fs.copyFile(file, path.join(output, file));
}
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
await fs.writeFile(
  path.join(output, 'package.json'),
  JSON.stringify(
    {
      name: 'chaos-desktop',
      productName: 'CHAOS',
      version,
      main: 'main.cjs',
      description: '从混乱中，明确下一步。',
      author: 'CHAOS',
      license: 'MIT',
    },
    null,
    2,
  ),
);
await build({
  entryPoints: ['apps/local-service/src/server.ts'],
  outfile: path.join(output, 'apps/local-service/src/server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['vite'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
for (const entry of ['main', 'preload']) {
  await build({
    entryPoints: [`apps/desktop/${entry}.ts`],
    outfile: path.join(output, `${entry}.cjs`),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['electron'],
  });
}
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'scripts/create-desktop-icon.ps1',
    '-OutputPath',
    path.join(output, 'icon.png'),
  ],
  { windowsHide: true },
);
const png = await fs.readFile(path.join(output, 'icon.png'));
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
await fs.writeFile(path.join(output, 'icon.ico'), Buffer.concat([header, png]));
console.log('Desktop build ready: .desktop (includes Python and SQLCipher).');
