import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { packager } from '@electron/packager';

assert.equal(process.platform, 'win32', 'Build the Windows desktop package on Windows.');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(project);
await fs.mkdir('releases', { recursive: true });
const release = await fs.mkdtemp(path.join(project, 'releases', 'CHAOS-desktop-'));
const [output] = await packager({
  dir: '.desktop',
  out: release,
  name: 'CHAOS',
  platform: 'win32',
  arch: 'x64',
  icon: '.desktop/icon.ico',
  asar: false,
  executableName: 'CHAOS',
  appBundleId: 'cn.chaos.workbench',
  prune: false,
  win32metadata: { CompanyName: 'CHAOS', FileDescription: 'CHAOS 工作台', ProductName: 'CHAOS' },
});
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
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Compress-Archive -LiteralPath $env:CHAOS_PACKAGE_SOURCE -DestinationPath $env:CHAOS_PACKAGE_ZIP',
  ],
  {
    windowsHide: true,
    env: {
      ...process.env,
      CHAOS_PACKAGE_SOURCE: output,
      CHAOS_PACKAGE_ZIP: path.join(release, 'CHAOS-Windows-x64.zip'),
    },
  },
);
console.log(`Desktop executable: ${path.join(output, 'CHAOS.exe')}`);
console.log(`Desktop package: ${path.join(release, 'CHAOS-Windows-x64.zip')}`);
