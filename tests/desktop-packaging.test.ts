import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const moduleUrl = new URL('../scripts/package-desktop.mjs', import.meta.url);
const { archiveInstalledElectron, zipDirectory } = await import(moduleUrl.href);
const testRoot = path.resolve('.test-vault');
const roots: string[] = [];
async function setup() {
  await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, 'packaging-'));
  roots.push(root);
  const dist = path.join(root, 'installed electron');
  await fs.mkdir(dist);
  await fs.writeFile(path.join(dist, 'electron.exe'), 'runtime fixture');
  await fs.writeFile(path.join(dist, 'version'), '45.2.1');
  return { root, dist };
}
function zipEntries(zip: string): string[] {
  return JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive = [System.IO.Compression.ZipFile]::OpenRead($env:CHAOS_TEST_ZIP); try { ConvertTo-Json -InputObject @($archive.Entries | ForEach-Object { $_.FullName }) } finally { $archive.Dispose() }',
      ],
      { windowsHide: true, encoding: 'utf8', env: { ...process.env, CHAOS_TEST_ZIP: zip } },
    ),
  ).map((name: string) => name.replaceAll('\\', '/'));
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    expect(path.dirname(await fs.realpath(root))).toBe(await fs.realpath(testRoot));
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('没有下载缓存且网络不可用时，从已安装 Electron 生成 Packager 所需的 ZIP', async () => {
  const { root, dist } = await setup();
  const request = vi.fn(() => {
    throw new Error('Network disabled');
  });
  vi.stubGlobal('fetch', request);
  const zip = path.join(root, 'electron-v45.2.1-win32-x64.zip');
  await archiveInstalledElectron(path.join(dist, 'electron.exe'), '45.2.1', zip);
  expect(zipEntries(zip).sort()).toEqual(['electron.exe', 'version']);
  expect(request).not.toHaveBeenCalled();
});

it('运行时版本不匹配时拒绝打包，不静默下载另一个版本', async () => {
  const { root, dist } = await setup();
  const zip = path.join(root, 'electron.zip');
  await expect(
    archiveInstalledElectron(path.join(dist, 'electron.exe'), '45.2.2', zip),
  ).rejects.toThrow('does not match');
  await expect(fs.stat(zip)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('发布 ZIP 保留根目录和 Windows 隐藏文件', async () => {
  const { root, dist } = await setup();
  const hidden = path.join(dist, 'hidden-runtime.txt');
  await fs.writeFile(hidden, 'must survive ZIP');
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.IO.File]::SetAttributes($env:CHAOS_HIDDEN_FILE, [System.IO.FileAttributes]::Hidden)',
    ],
    { windowsHide: true, env: { ...process.env, CHAOS_HIDDEN_FILE: hidden } },
  );
  const zip = path.join(root, 'release.zip');
  zipDirectory(dist, zip, true);
  expect(zipEntries(zip)).toContain('installed electron/hidden-runtime.txt');
});
