import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import qrcode from 'qrcode-generator';

const root = path.resolve(import.meta.dirname, '..');
const sdk =
  process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(root, '.android-tools/sdk');
const executable = path.join(
  sdk,
  'platform-tools',
  process.platform === 'win32' ? 'adb.exe' : 'adb',
);
function adb(...args) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: args.includes('instrument') ? 300000 : 120000,
  });
  if (result.status !== 0)
    throw new Error(`adb ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const serial =
  process.env.ANDROID_SERIAL ||
  adb('devices')
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/)[0])
    .find((id) => id.startsWith('emulator-'));
if (!serial)
  throw new Error('先启动 Android Studio 模拟器。此脚本默认只使用模拟器，不访问个人手机。');
const device = (...args) => adb('-s', serial, ...args);
const directory = '/sdcard/Documents/CHAOS-Android-Test';
const output = path.join(root, 'test-results/android');
fs.mkdirSync(output, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
async function eventually(fn, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await pause(400);
    }
  }
  throw new Error(description + ': ' + last?.message);
}
async function connectWebView() {
  return eventually(
    async () => {
      const pid = device('shell', 'pidof', 'com.chaos.workbench').trim();
      assert.match(pid, /^\d+$/);
      device('forward', 'tcp:9223', `localabstract:webview_devtools_remote_${pid}`);
      const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { noDefaults: true });
      const page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().startsWith('https://localhost'));
      assert.ok(page, 'waiting for local WebView');
      page.setDefaultTimeout(60000);
      await page.getByRole('navigation', { name: '手机导航' }).waitFor();
      return { browser, page };
    },
    '无法连接 APK 的调试 WebView',
    45000,
  );
}
async function tapNative(pattern) {
  return eventually(async () => {
    device('shell', 'uiautomator', 'dump', '/sdcard/chaos-ui.xml');
    const xml = device('shell', 'cat', '/sdcard/chaos-ui.xml');
    const nodes = xml.match(/<node\b[^>]+>/g) || [];
    const node = nodes.find((node) => {
      const label =
        /\btext="([^"]*)"/.exec(node)?.[1] || /\bcontent-desc="([^"]*)"/.exec(node)?.[1] || '';
      return pattern.test(label);
    });
    assert.ok(node, '找不到系统控件 ' + pattern);
    const [, x1, y1, x2, y2] = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
    device(
      'shell',
      'input',
      'tap',
      String(Math.round((+x1 + +x2) / 2)),
      String(Math.round((+y1 + +y2) / 2)),
    );
  }, '系统目录授权未完成');
}
let browser;
let wifiChild;
function nativeTests() {
  const qr = qrcode(0, 'M');
  qr.addData(
    'http://10.0.2.2:4321/chaos-exchange/00000000-0000-0000-0000-000000000000#00000000000000000000000000000000',
  );
  qr.make();
  const image = path.join(output, 'pairing.gif');
  fs.writeFileSync(image, Buffer.from(qr.createDataURL(5, 20).split(',')[1], 'base64'));
  device('shell', 'mkdir', '-p', directory + '/instrumentation');
  device('push', image, directory + '/instrumentation/pairing.gif');
  device(
    'install',
    '-r',
    path.join(
      root,
      'apps/android/native/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk',
    ),
  );
  const instrumentation = device(
    'shell',
    'am',
    'instrument',
    '-w',
    '-r',
    '-e',
    'class',
    'com.chaos.workbench.DocumentStoreTest',
    'com.chaos.workbench.test/androidx.test.runner.AndroidJUnitRunner',
  );
  fs.writeFileSync(path.join(output, 'instrumentation.txt'), instrumentation);
  assert.match(instrumentation, /OK \(8 tests\)/);
  assert.doesNotMatch(instrumentation, /FAILURES|INSTRUMENTATION_FAILED/);
  // Remove only the reserved synthetic fault fixtures before timing business UI operations.
  const fixtures = device('shell', 'readlink', '-f', directory + '/instrumentation');
  assert.equal(fixtures, '/storage/emulated/0/Documents/CHAOS-Android-Test/instrumentation');
  device('shell', 'rm', '-rf', '--', fixtures);
  checks.push('真实 SAF：15 个发布中断位置恢复、冲突拒绝、路径防护、严格 UTF-8、目录独占');
}
try {
  device(
    'install',
    '-r',
    path.join(root, 'apps/android/native/app/build/outputs/apk/debug/app-debug.apk'),
  );
  device('shell', 'mkdir', '-p', directory);
  device('shell', 'am', 'start', '-n', 'com.chaos.workbench/.MainActivity');
  let connection = await connectWebView();
  browser = connection.browser;
  let page = connection.page;
  // A remembered directory must be the dedicated synthetic directory before this script writes anything.
  const connected = await eventually(async () => {
    const heading = page.getByRole('navigation', { name: '今日导航', exact: true });
    const picker = page.getByRole('button', { name: '选择文件夹', exact: true });
    assert.ok((await heading.count()) || (await picker.count()));
    return Boolean(await heading.count());
  }, '应用未显示连接或今日界面');
  if (connected) {
    const preferences = device(
      'shell',
      'run-as',
      'com.chaos.workbench',
      'cat',
      'shared_prefs/chaos-local.xml',
    );
    assert.match(preferences, /CHAOS-Android-Test/, '测试拒绝连接个人工作目录');
  } else {
    await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
    await tapNative(/^CHAOS-Android-Test$/);
    await tapNative(/^(USE THIS FOLDER|使用此文件夹)$/i);
    await tapNative(/^(ALLOW|允许)$/i);
    const needsTakeover = await eventually(
      async () => {
        if (await page.getByRole('navigation', { name: '今日导航', exact: true }).isVisible())
          return false;
        assert.ok(await page.getByText('等待确认重新授权旧目录', { exact: true }).isVisible());
        return true;
      },
      '等待目录连接或旧授权确认',
      45000,
    );
    if (needsTakeover) await tapNative(/^接管并恢复$/);
    await page
      .getByRole('navigation', { name: '今日导航', exact: true })
      .waitFor({ timeout: 45000 });
  }
  checks.push('真实 SAF 目录授权与连接');
  await browser.close();
  browser = null;
  device('shell', 'am', 'force-stop', 'com.chaos.workbench');
  nativeTests();
  device('shell', 'am', 'force-stop', 'com.chaos.workbench');
  const canonicalTestRoot = device('shell', 'readlink', '-f', directory);
  assert.equal(canonicalTestRoot, '/storage/emulated/0/Documents/CHAOS-Android-Test');
  const legacyOwner = path.join(output, 'legacy-owner.json');
  fs.writeFileSync(
    legacyOwner,
    JSON.stringify({ device: 'legacy-installation-for-reinstall-test' }),
  );
  device('push', legacyOwner, directory + '/.atlas/android-owner.json');
  device('shell', 'pm', 'clear', 'com.chaos.workbench');
  device('shell', 'am', 'start', '-n', 'com.chaos.workbench/.MainActivity');
  connection = await connectWebView();
  browser = connection.browser;
  page = connection.page;
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await tapNative(/^CHAOS-Android-Test$/);
  await tapNative(/^(USE THIS FOLDER|使用此文件夹)$/i);
  await tapNative(/^(ALLOW|允许)$/i);
  await tapNative(/^接管并恢复$/);
  await page.getByRole('navigation', { name: '今日导航', exact: true }).waitFor({ timeout: 45000 });
  checks.push('模拟重装后重新授权旧目录，确认接管并保留原工作内容');
  const nav = (name) =>
    page
      .getByRole('navigation', { name: '手机导航' })
      .getByRole('button', { name, exact: true })
      .click();
  await nav('工作空间');
  if (!(await page.getByRole('heading', { name: '移动端验收', exact: true }).count())) {
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByRole('dialog').getByLabel('标题', { exact: true }).fill('移动端验收');
    await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  const project = page.getByRole('region', { name: '项目 · 移动端验收', exact: true });
  for (const title of ['下一步研究', '方法验证']) {
    if (await page.getByRole('button', { name: `打开业务线 ${title}`, exact: true }).count())
      continue;
    await project.getByRole('button', { name: '添加业务线 · 移动端验收', exact: true }).click();
    await page.getByRole('dialog').getByLabel('标题', { exact: true }).fill(title);
    await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  await page.locator('.mobile-main').evaluate((element) => element.scrollTo({ top: 0 }));
  await page.screenshot({ path: path.join(output, 'workspace-navigation.png') });
  device('shell', 'screencap', '-p', '/sdcard/chaos-preview.png');
  device('pull', '/sdcard/chaos-preview.png', path.join(output, 'android-screen.png'));
  await page.getByRole('button', { name: '打开业务线 下一步研究', exact: true }).click();
  if (!(await page.getByRole('checkbox', { name: '完成节点 方案讨论', exact: true }).count())) {
    await page.getByRole('button', { name: '添加节点', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('标题', { exact: true }).fill('方案讨论');
    await dialog.getByLabel('节点标签', { exact: true }).fill('讨论');
    const today = await page.evaluate(() => {
      const date = new Date();
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    });
    await dialog.getByLabel('截止日期', { exact: true }).fill(today);
    await dialog.getByLabel('截止时刻', { exact: true }).fill('14:00');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  const node = page.getByRole('article', { name: '节点 · 方案讨论', exact: true });
  if (!(await page.getByRole('checkbox', { name: '完成 整理讨论材料', exact: true }).count())) {
    await node.getByRole('button', { name: '待办', exact: true }).click();
    await page.getByRole('dialog').getByLabel('标题', { exact: true }).fill('整理讨论材料');
    await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  const previousCompletion = page.getByRole('checkbox', { name: '完成 整理讨论材料', exact: true });
  if (await previousCompletion.isChecked()) await previousCompletion.click();
  const dimensions = /(?:Physical|Override) size: (\d+)x(\d+)/.exec(device('shell', 'wm', 'size'));
  assert.ok(dimensions);
  device(
    'shell',
    'input',
    'swipe',
    String(Math.round(+dimensions[1] * 0.85)),
    String(Math.round(+dimensions[2] * 0.55)),
    String(Math.round(+dimensions[1] * 0.15)),
    String(Math.round(+dimensions[2] * 0.55)),
    '300',
  );
  await page.getByRole('heading', { name: '方法验证', exact: true }).waitFor();
  await page.getByRole('button', { name: '上一条业务线', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'vertical-line.png') });
  checks.push('项目、业务线、节点和待办创建；竖向业务线与切线');
  await nav('笔记');
  await page.getByRole('button', { name: '打开业务线 下一步研究', exact: true }).click();
  await page.getByLabel('随手记', { exact: true }).fill('先验证关键假设，再决定下一步。');
  await page.getByRole('button', { name: '记到笔记', exact: true }).click();
  await eventually(
    async () => assert.equal(await page.getByLabel('随手记', { exact: true }).inputValue(), ''),
    '笔记保存失败',
  );
  await page.screenshot({ path: path.join(output, 'notes.png') });
  checks.push('随手记写入同一份业务线 Notes');
  device('shell', 'svc', 'wifi', 'disable');
  device('shell', 'svc', 'data', 'disable');
  await nav('今日已做');
  const existingRecord = page
    .getByRole('button', { name: '编辑记录 · 离线整理讨论材料', exact: true })
    .first();
  const updatingActual = Boolean(await existingRecord.count());
  if (updatingActual) await existingRecord.click();
  else await nav('编辑');
  await page.getByLabel('具体事件', { exact: true }).fill('离线整理讨论材料');
  await page.getByLabel('开始时间', { exact: true }).fill('09:00');
  await page.getByLabel('结束时间', { exact: true }).fill('10:00');
  if (!updatingActual) {
    await page
      .locator('.actual-pool-choice')
      .filter({ hasText: '整理讨论材料' })
      .getByRole('button', { name: '加入', exact: true })
      .click();
  }
  const completion = page.getByLabel('本次完成 整理讨论材料', { exact: true });
  if (await completion.isEnabled()) await completion.check();
  await page.getByRole('button', { name: '保存实际工作', exact: true }).click();
  if (updatingActual) await page.getByRole('dialog').waitFor({ state: 'hidden' });
  else
    await eventually(
      async () => assert.equal(await page.getByLabel('具体事件', { exact: true }).inputValue(), ''),
      '离线实际记录保存失败',
    );
  await nav('今日已做');
  await page.getByText('离线整理讨论材料', { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(output, 'actuals.png') });
  checks.push('关闭网络后，实际记录＋本次完成联合保存');
  await nav('回顾');
  await page.getByRole('region', { name: '本周概况', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'review.png') });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '创建管理数据快照', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已备份' }).waitFor();
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  const restoreMarker = '只用于恢复验收的临时随手记 ' + Date.now();
  await nav('笔记');
  await page.getByRole('button', { name: '打开业务线 下一步研究', exact: true }).click();
  await page.getByLabel('随手记', { exact: true }).fill(restoreMarker);
  await page.getByRole('button', { name: '记到笔记', exact: true }).click();
  await eventually(
    async () => assert.equal(await page.getByLabel('随手记', { exact: true }).inputValue(), ''),
    '恢复前的测试笔记未保存',
  );
  await page
    .locator('.markdown-body')
    .getByText(restoreMarker, { exact: true })
    .waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '恢复', exact: true }).first().click();
  await page.getByRole('status').filter({ hasText: '已恢复' }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await eventually(
    async () =>
      assert.ok(!(await page.locator('.markdown-body').innerText()).includes(restoreMarker)),
    '手动恢复没有还原 Notes',
  );
  checks.push('回顾、手动备份与恢复');
  // Only synthetic transfer files are created in Downloads; business writes stay in the test vault.
  const exchangeRoot = fs.mkdtempSync(path.join(root, '.test-vault/android-exchange-'));
  const fixture = (mode) => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/test-android-exchange-fixture.ts', exchangeRoot, mode],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 60000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  fixture('prepare');
  const metadata = JSON.parse(fs.readFileSync(path.join(exchangeRoot, 'metadata.json'), 'utf8'));
  const transferName = 'CHAOS-Android-Test-' + path.basename(exchangeRoot) + '.json';
  const transferPath = '/sdcard/Download/' + transferName;
  device('push', path.join(exchangeRoot, 'send.json'), transferPath);
  const downloads = async () => {
    await tapNative(/^(Show roots|显示根目录)$/i);
    await tapNative(/^(Downloads|下载)$/i);
  };
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const exchange = page.getByRole('region', { name: '设备增量交换' });
  await exchange.getByText('离线文件交换', { exact: true }).click();
  await exchange.getByRole('button', { name: '打开交换文件或回执', exact: true }).click();
  await downloads();
  await tapNative(new RegExp('^' + transferName.replaceAll('.', '\\.') + '$'));
  await exchange
    .getByRole('button', { name: '确认导入并生成回执', exact: true })
    .waitFor({ timeout: 60000 });
  await exchange.getByRole('button', { name: '确认导入并生成回执', exact: true }).click();
  await exchange.getByRole('status').filter({ hasText: '已导入' }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await nav('工作空间');
  await page.getByRole('button', { name: `打开业务线 ${metadata.lineTitle}`, exact: true }).click();
  await page.getByRole('checkbox', { name: `完成 ${metadata.todoTitle}`, exact: true }).click();
  await eventually(
    async () =>
      assert.equal(
        await page
          .getByRole('checkbox', { name: `完成 ${metadata.todoTitle}`, exact: true })
          .isChecked(),
        true,
      ),
    '交换后的待办没有完成',
  );
  await nav('笔记');
  await page.getByRole('button', { name: `打开业务线 ${metadata.lineTitle}`, exact: true }).click();
  await page.getByLabel('随手记', { exact: true }).fill(metadata.memo);
  await page.getByRole('button', { name: '记到笔记', exact: true }).click();
  await eventually(
    async () => assert.equal(await page.getByLabel('随手记', { exact: true }).inputValue(), ''),
    '交换测试笔记未保存',
  );
  await page
    .locator('.markdown-body')
    .getByText(metadata.memo, { exact: true })
    .waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await exchange.getByText('离线文件交换', { exact: true }).click();
  await exchange.getByRole('button', { name: '生成发送包', exact: true }).click();
  await exchange.getByText('查看 JSON', { exact: true }).click();
  const reply = JSON.parse(await exchange.getByLabel('导出的交换 JSON').inputValue());
  await exchange.getByRole('button', { name: '保存发送包', exact: true }).click();
  await downloads();
  await tapNative(/^(SAVE|保存)$/i);
  await exchange.getByRole('status').filter({ hasText: '文件已保存' }).waitFor({ timeout: 60000 });
  const replyPath = '/sdcard/Download/CHAOS-changes-' + reply.id + '.json';
  device('pull', replyPath, path.join(exchangeRoot, 'reply.json'));
  fixture('verify');
  for (const file of [transferPath, replyPath]) {
    assert.match(
      file,
      /^\/sdcard\/Download\/CHAOS-(?:Android-Test-android-exchange-[A-Za-z0-9]+|changes-[a-f0-9-]{36})\.json$/,
    );
    device('shell', 'rm', '--', file);
  }
  await page.screenshot({ path: path.join(output, 'exchange.png') });
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  checks.push('Windows JSON → Android 系统文件读取、预览导入、修改与文件保存 → Windows 增量回传');
  device('shell', 'svc', 'wifi', 'enable');
  device('shell', 'svc', 'data', 'enable');
  wifiChild = fork('scripts/test-android-exchange-fixture.ts', [exchangeRoot, 'wifi'], {
    cwd: root,
    execArgv: ['--import', 'tsx'],
    silent: true,
    windowsHide: true,
  });
  wifiChild.stdout.resume();
  wifiChild.stderr.resume();
  const wifiMessage = (type) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        wifiChild.off('message', handler);
        reject(new Error('Wi-Fi 测试服务超时'));
      }, 30000);
      const handler = (message) => {
        if (message.type === 'error' || message.type === type) {
          clearTimeout(timer);
          wifiChild.off('message', handler);
          if (message.type === 'error') reject(new Error(message.error));
          else resolve();
        }
      };
      wifiChild.on('message', handler);
    });
  await wifiMessage('ready');
  const wifi = JSON.parse(fs.readFileSync(path.join(exchangeRoot, 'wifi.json'), 'utf8'));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const wifiPanel = page.getByRole('region', { name: 'Wi-Fi 直连', exact: true });
  await wifiPanel.getByLabel('电脑配对连接', { exact: true }).fill(wifi.pairing);
  await wifiPanel.getByRole('button', { name: '读取电脑变化', exact: true }).click();
  await wifiPanel
    .getByRole('button', { name: '确认导入电脑变化', exact: true })
    .waitFor({ timeout: 60000 });
  await wifiPanel.getByRole('button', { name: '确认导入电脑变化', exact: true }).click();
  await wifiPanel.getByRole('status').filter({ hasText: '确认已返回' }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await nav('工作空间');
  await page.getByRole('heading', { name: wifi.title, exact: true }).waitFor();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByRole('dialog').getByLabel('标题', { exact: true }).fill(wifi.phoneTitle);
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await wifiPanel.getByLabel('电脑配对连接', { exact: true }).fill(wifi.pairing);
  await wifiPanel.getByRole('button', { name: '发送手机变化', exact: true }).click();
  await wifiPanel.getByRole('status').filter({ hasText: '变化已送达' }).waitFor({ timeout: 60000 });
  const confirmed = wifiMessage('confirmed');
  wifiChild.send({ type: 'confirm' });
  await confirmed;
  await wifiPanel
    .getByRole('status')
    .filter({ hasText: '电脑已确认导入' })
    .waitFor({ timeout: 60000 });
  await page.screenshot({ path: path.join(output, 'wifi-exchange.png') });
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  const exited = once(wifiChild, 'exit');
  wifiChild.send({ type: 'stop' });
  await exited;
  wifiChild = null;
  checks.push('Android 原生局域网密文传输：拉取电脑变化、手机确认、推送变化、电脑确认与自动回执');
  wifiChild = fork('scripts/test-android-exchange-fixture.ts', [exchangeRoot, 'wifi-hang'], {
    cwd: root,
    execArgv: ['--import', 'tsx'],
    silent: true,
    windowsHide: true,
  });
  wifiChild.stdout.resume();
  wifiChild.stderr.resume();
  await wifiMessage('ready');
  const stalled = JSON.parse(fs.readFileSync(path.join(exchangeRoot, 'wifi.json'), 'utf8'));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await wifiPanel.getByLabel('电脑配对连接', { exact: true }).fill(stalled.pairing);
  await wifiPanel.getByRole('button', { name: '读取电脑变化', exact: true }).click();
  const progress = page.getByRole('region', { name: '操作进度', exact: true });
  await progress.getByText('请求已发送，正在等待电脑整理数据', { exact: true }).waitFor();
  await progress.getByText(/已用 [1-9]\d* 秒/).waitFor();
  const progressBounds = await progress.boundingBox();
  assert.ok(
    progressBounds &&
      progressBounds.y >= 0 &&
      progressBounds.y + progressBounds.height <= (await page.evaluate(() => innerHeight)),
    '进度面板必须在当前可视区域',
  );
  device('shell', 'screencap', '-p', '/sdcard/chaos-progress.png');
  device('pull', '/sdcard/chaos-progress.png', path.join(output, 'wifi-progress.png'));
  await wifiPanel
    .getByRole('alert')
    .filter({ hasText: '连接电脑超时' })
    .waitFor({ timeout: 40000 });
  await progress.waitFor({ state: 'hidden' });
  await wifiPanel.getByRole('button', { name: '读取电脑变化', exact: true }).click();
  await progress.getByText('请求已发送，正在等待电脑整理数据', { exact: true }).waitFor();
  await progress.getByRole('button', { name: '停止本次操作', exact: true }).click();
  await progress.waitFor({ state: 'hidden', timeout: 10000 });
  await eventually(
    async () =>
      assert.ok(
        await wifiPanel.getByRole('button', { name: '读取电脑变化', exact: true }).isEnabled(),
      ),
    '取消后读取按钮未恢复',
  );
  await wifiPanel.getByRole('button', { name: '读取电脑变化', exact: true }).click();
  await progress.getByText('请求已发送，正在等待电脑整理数据', { exact: true }).waitFor();
  checks.push('电脑无响应时显示真实阶段与计时，超时提示、停止读取及重试均可恢复操作');
  await browser.close();
  browser = null;
  device('shell', 'am', 'force-stop', 'com.chaos.workbench');
  device('shell', 'am', 'start', '-n', 'com.chaos.workbench/.MainActivity');
  connection = await connectWebView();
  browser = connection.browser;
  page = connection.page;
  await page.getByRole('navigation', { name: '今日导航', exact: true }).waitFor({ timeout: 30000 });
  await page
    .getByRole('navigation', { name: '手机导航' })
    .getByRole('button', { name: '今日已做', exact: true })
    .click();
  await page.getByText('离线整理讨论材料', { exact: true }).first().waitFor();
  checks.push('进程终止后离线重启，恢复目录授权与内容');
  await browser.close();
  browser = null;
  device('shell', 'am', 'force-stop', 'com.chaos.workbench');
  fs.writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify({ serial, checks, date: new Date().toISOString() }, null, 2),
  );
  console.log(checks.join('\n'));
  device('shell', 'am', 'start', '-n', 'com.chaos.workbench/.MainActivity');
} finally {
  wifiChild?.kill();
  await browser?.close();
  device('shell', 'svc', 'wifi', 'enable');
  device('shell', 'svc', 'data', 'enable');
  device('forward', '--remove', 'tcp:9223');
}
