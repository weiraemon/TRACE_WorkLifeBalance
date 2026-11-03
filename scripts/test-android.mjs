import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';

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
      page.setDefaultTimeout(15000);
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
function nativeTests() {
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
  assert.match(instrumentation, /OK \(4 tests\)/);
  assert.doesNotMatch(instrumentation, /FAILURES|INSTRUMENTATION_FAILED/);
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
    const heading = page.getByRole('heading', { name: '今天，先做什么', exact: true });
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
    await page
      .getByRole('heading', { name: '今天，先做什么', exact: true })
      .waitFor({ timeout: 45000 });
  }
  checks.push('真实 SAF 目录授权与连接');
  await browser.close();
  browser = null;
  device('shell', 'am', 'force-stop', 'com.chaos.workbench');
  nativeTests();
  device('shell', 'am', 'start', '-n', 'com.chaos.workbench/.MainActivity');
  connection = await connectWebView();
  browser = connection.browser;
  page = connection.page;
  await page
    .getByRole('heading', { name: '今天，先做什么', exact: true })
    .waitFor({ timeout: 45000 });
  const nav = (name) =>
    page
      .getByRole('navigation', { name: '手机导航' })
      .getByRole('button', { name, exact: true })
      .click();
  await nav('工作空间');
  if (!(await page.getByRole('button', { name: '查看项目 移动端验收', exact: true }).count())) {
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByRole('dialog').getByLabel('标题', { exact: true }).fill('移动端验收');
    await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  const project = page.getByRole('region', { name: '项目 · 移动端验收', exact: true });
  for (const title of ['下一步研究', '方法验证']) {
    if (await page.getByRole('button', { name: `打开业务线 ${title}`, exact: true }).count())
      continue;
    await project.getByRole('button', { name: '添加业务线', exact: true }).click();
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
    await dialog.getByText('可选设置', { exact: true }).click();
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
    await page.getByText('关联节点或待办（可选）', { exact: true }).click();
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
  await page.getByRole('heading', { name: '回顾', exact: true }).waitFor();
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
  await page.locator('.markdown-body').getByText(restoreMarker, { exact: true }).waitFor({ timeout: 60000 });
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
  await browser.close();
  browser = null;
  device('shell', 'am', 'force-stop', 'com.chaos.workbench');
  device('shell', 'am', 'start', '-n', 'com.chaos.workbench/.MainActivity');
  connection = await connectWebView();
  browser = connection.browser;
  page = connection.page;
  await page
    .getByRole('heading', { name: '今天，先做什么', exact: true })
    .waitFor({ timeout: 30000 });
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
  await browser?.close();
  device('shell', 'svc', 'wifi', 'enable');
  device('shell', 'svc', 'data', 'enable');
  device('forward', '--remove', 'tcp:9223');
}
