import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { packager } from '@electron/packager';
import { archiveInstalledElectron, validateReleasePaths } from './package-desktop.mjs';

assert.equal(process.platform, 'win32', 'Build this preview on Windows x64.');
assert.equal(process.arch, 'x64');
const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
const electronVersion = require('electron/package.json').version;
const cache = path.join(root, '.test-vault');
await fs.mkdir(cache, { recursive: true });
const staging = await fs.mkdtemp(path.join(cache, 'android-preview-package-'));
const source = path.join(staging, 'app');
await fs.mkdir(source);
for (const file of [
  'dist',
  'apps',
  'preload.cjs',
  'icon.ico',
  'icon.png',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
])
  await fs.cp(path.join(root, '.desktop', file), path.join(source, file), { recursive: true });
await fs.copyFile(path.join(root, '.desktop/main.cjs'), path.join(source, 'shell.cjs'));
await fs.writeFile(
  path.join(source, 'main.cjs'),
  "process.argv.push('--android-preview'); require('./shell.cjs');\n",
);
await fs.writeFile(
  path.join(source, 'package.json'),
  JSON.stringify({
    name: 'chaos-android-preview',
    version,
    main: 'main.cjs',
    description: 'Android 竖屏界面本地预览',
    author: 'CHAOS',
    license: 'MIT',
  }),
);
await build({
  entryPoints: ['scripts/sample-vault.ts'],
  outfile: path.join(source, 'sample-vault.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const electronZipDir = path.join(staging, 'electron');
await fs.mkdir(electronZipDir);
await archiveInstalledElectron(
  require('electron'),
  electronVersion,
  path.join(electronZipDir, `electron-v${electronVersion}-win32-x64.zip`),
);
const release = path.join(root, 'releases', `CHAOS-Android-Preview-${version}`);
await fs.mkdir(release, { recursive: true });
const [output] = await packager({
  dir: source,
  out: release,
  name: 'CHAOS-Android-Preview',
  platform: 'win32',
  arch: 'x64',
  electronVersion,
  electronZipDir,
  icon: path.join(source, 'icon.ico'),
  asar: false,
  executableName: 'CHAOS-Android-Preview',
  prune: false,
  overwrite: true,
  appBundleId: 'cn.chaos.android.preview',
  win32metadata: {
    CompanyName: 'CHAOS',
    FileDescription: 'CHAOS Android 界面预览',
    ProductName: 'CHAOS Android Preview',
  },
});
await fs.writeFile(
  path.join(output, '使用说明.txt'),
  `CHAOS Android 界面预览（电脑运行）\r\n\r\n双击 CHAOS-Android-Preview.exe；使用 390×844 竖屏窗口，可拖动调整大小。\r\n六入口与 Android 共用同一套界面和业务服务，鼠标点击、滚轮上下滚动，业务线可左右拖动或用切线按钮。\r\n无需 Node.js、Android Studio 或模拟器；关闭窗口即退出。\r\n首次自动创建合成示例，后续保留你的测试修改。示例与配置位于 %APPDATA%\\CHAOS-Android-Preview，和 Windows 正式版隔离。\r\n这只是手机布局与交互预览，不运行 Android 系统；软键盘、返回键、SAF 权限与文件能力请安装同目录中的 APK 验证。\r\n卸载只删除程序，不删除示例工作目录。无跨设备同步。\r\n`,
);
const files = await fs.readdir(output, { recursive: true, withFileTypes: true });
validateReleasePaths(
  files.map((file) => path.relative(path.dirname(output), path.join(file.parentPath, file.name))),
);

// Pinned official portable compiler; never install a global build tool.
const tools = path.join(cache, 'installer-tools');
await fs.mkdir(tools, { recursive: true });
const zip = path.join(tools, 'nsis-3.11.zip');
let data = await fs.readFile(zip).catch(() => undefined);
if (!data) {
  const response = await fetch(
    'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.11/nsis-3.11.zip',
    { signal: AbortSignal.timeout(120000) },
  );
  assert.ok(response.ok, 'NSIS download failed');
  data = Buffer.from(await response.arrayBuffer());
}
assert.equal(
  createHash('sha256').update(data).digest('hex'),
  'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1',
  'NSIS checksum mismatch',
);
await fs.writeFile(zip, data);
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Expand-Archive -LiteralPath $env:CHAOS_NSIS_ZIP -DestinationPath $env:CHAOS_NSIS_TOOLS -Force',
  ],
  { windowsHide: true, env: { ...process.env, CHAOS_NSIS_ZIP: zip, CHAOS_NSIS_TOOLS: tools } },
);
const escape = (value) => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
const uninstall = path.join(staging, 'uninstall-files.nsh');
const relative = (file) => path.relative(output, path.join(file.parentPath, file.name));
await fs.writeFile(
  uninstall,
  files
    .filter((file) => file.isFile())
    .map((file) => `Delete "$INSTDIR\\${escape(relative(file))}"`)
    .concat(
      files
        .filter((file) => file.isDirectory())
        .sort((a, b) => relative(b).length - relative(a).length)
        .map((file) => `RMDir "$INSTDIR\\${escape(relative(file))}"`),
    )
    .join('\n'),
);
const installer = path.join(root, 'releases', `CHAOS-Android-Preview-${version}-Setup.exe`);
execFileSync(
  path.join(tools, 'nsis-3.11/makensis.exe'),
  [
    '/V2',
    `/DPAYLOAD=${output}`,
    `/DOUTPUT=${installer}`,
    `/DVERSION=${version}`,
    `/DUNINSTALL_FILES=${uninstall}`,
    path.join(root, 'scripts/android-preview.nsi'),
  ],
  { windowsHide: true, stdio: 'inherit' },
);
await fs.writeFile(
  installer + '.sha256',
  createHash('sha256')
    .update(await fs.readFile(installer))
    .digest('hex') +
    '  ' +
    path.basename(installer) +
    '\n',
);
assert.equal(path.dirname(await fs.realpath(staging)), await fs.realpath(cache));
await fs.rm(staging, { recursive: true, force: true });
console.log('Android UI preview installer: ' + installer);
console.log('Portable preview: ' + path.join(output, 'CHAOS-Android-Preview.exe'));
