import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { packager } from '@electron/packager';

const releaseName =
  /^CHAOS-(?:desktop(?:-[A-Za-z0-9]+)?|Windows-v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/;

export function zipDirectory(source, destination, includeRoot = false) {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:CHAOS_ZIP_SOURCE, $env:CHAOS_ZIP_DESTINATION, [System.IO.Compression.CompressionLevel]::Optimal, $env:CHAOS_ZIP_INCLUDE_ROOT -eq 'true')",
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        CHAOS_ZIP_SOURCE: path.resolve(source),
        CHAOS_ZIP_DESTINATION: path.resolve(destination),
        CHAOS_ZIP_INCLUDE_ROOT: String(includeRoot),
      },
    },
  );
}

export async function archiveInstalledElectron(executable, version, destination) {
  const directory = path.dirname(executable);
  assert.ok((await fs.stat(executable)).isFile(), 'Electron is not installed; run npm ci first.');
  assert.equal(
    (await fs.readFile(path.join(directory, 'version'), 'utf8')).trim().replace(/^v/, ''),
    version,
    'Installed Electron does not match its package version; run npm ci first.',
  );
  zipDirectory(directory, destination);
}

export async function pruneDesktopReleases(directory, keepDirectory) {
  const info = await fs.lstat(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Release root must be a real directory.');
  const root = await fs.realpath(directory);
  const keep = await fs.realpath(keepDirectory);
  assert.ok(
    path.dirname(keep) === root && releaseName.test(path.basename(keep)),
    'Keep directory must be a generated release directly inside releases.',
  );
  const archive = await fs.lstat(path.join(keep, 'CHAOS-Windows-x64.zip'));
  assert.ok(
    archive.isFile() && !archive.isSymbolicLink() && archive.size > 0,
    'Keep the previous release until the new ZIP is complete.',
  );
  const removed = [];
  for (const child of await fs.readdir(root, { withFileTypes: true })) {
    if (!child.isDirectory() || !releaseName.test(child.name)) continue;
    const target = await fs.realpath(path.join(root, child.name));
    if (target === keep) continue;
    assert.equal(path.dirname(target), root, 'Refuse cleanup outside the release directory.');
    await fs.rm(target, { recursive: true, force: true });
    removed.push(child.name);
  }
  return removed;
}

async function main() {
  assert.equal(process.platform, 'win32', 'Build the Windows desktop package on Windows.');
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(project);
  await fs.mkdir('releases', { recursive: true });
  const release = await fs.mkdtemp(path.join(project, 'releases', 'CHAOS-desktop-'));
  const require = createRequire(import.meta.url);
  const electronVersion = require('electron/package.json').version;
  const staging = path.join(project, '.test-vault');
  await fs.mkdir(staging, { recursive: true });
  const electronZipDir = await fs.mkdtemp(path.join(staging, 'electron-package-'));
  let output;
  try {
    // Packager requires a ZIP. Reuse the installed runtime instead of downloading it again.
    await archiveInstalledElectron(
      require('electron'),
      electronVersion,
      path.join(electronZipDir, `electron-v${electronVersion}-win32-x64.zip`),
    );
    [output] = await packager({
      dir: '.desktop',
      out: release,
      name: 'CHAOS',
      platform: 'win32',
      arch: 'x64',
      electronVersion,
      electronZipDir,
      icon: '.desktop/icon.ico',
      asar: false,
      executableName: 'CHAOS',
      appBundleId: 'cn.chaos.workbench',
      prune: false,
      win32metadata: {
        CompanyName: 'CHAOS',
        FileDescription: 'CHAOS 工作台',
        ProductName: 'CHAOS',
      },
    });
  } finally {
    assert.equal(path.dirname(await fs.realpath(electronZipDir)), await fs.realpath(staging));
    await fs.rm(electronZipDir, { recursive: true, force: true });
  }
  await fs.writeFile(
    path.join(output, '使用说明.txt'),
    `CHAOS Windows 桌面版

解压整个文件夹到本机可写目录，双击 CHAOS.exe。可右键发送桌面快捷方式。
无需安装 Node.js、Python 或浏览器，无需保留命令行窗口。
首次使用点击“浏览文件夹…”选择 Markdown 工作目录；旧用户选择原目录即可。
关闭应用会同时停止本地服务与 QQ 自动同步；再次启动会恢复工作目录。
跨天自动更新今日安排，空白记录跟随当前时间，已填写草稿保留原日期和时间。

包含工作空间、今日、知识、回顾、Notes、备份、QQ 读取与同步、AI 设置等全部现有功能。
QQ 首次使用：备份 → QQ同步设置 → QQ自动同步全局设置 → 初始化 QQ 数据库读取。
Python 与 SQLCipher 已内置；QQ 软件、本人账号登录、数据库密钥与 AI API 密钥需自行配置。
微信数据源沿用当前占位入口。密钥与目录配置保存在本机用户配置目录，不随程序分发。
升级前退出旧版，解压新版后直接打开；程序不会迁移或批量改写用户 Markdown。
`,
  );
  const zip = path.join(release, 'CHAOS-Windows-x64.zip');
  // ZipFile includes hidden files that Compress-Archive can omit.
  zipDirectory(output, zip, true);
  const digest = createHash('sha256')
    .update(await fs.readFile(zip))
    .digest('hex');
  await fs.writeFile(path.join(release, 'SHA256SUMS.txt'), digest + '  CHAOS-Windows-x64.zip\n');
  const removed = await pruneDesktopReleases(path.join(project, 'releases'), release);
  if (removed.length) console.log('Removed older local packages: ' + removed.join(', '));
  console.log(`Desktop executable: ${path.join(output, 'CHAOS.exe')}`);
  console.log(`Desktop package: ${path.join(release, 'CHAOS-Windows-x64.zip')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
