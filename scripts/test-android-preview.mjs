import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const installer = path.resolve(
  process.argv[2] || `releases/CHAOS-Android-Preview-${version}-Setup.exe`,
);
await fs.mkdir('.test-vault', { recursive: true });
const testRoot = await fs.mkdtemp(path.resolve('.test-vault/android-preview-install-'));
const installed = path.join(testRoot, '安装 with spaces');
execFileSync(installer, ['/S', '/NOINTEGRATION', `/D=${installed}`], {
  windowsHide: true,
  // NSIS requires /D to be the final, unquoted remainder, including any spaces.
  windowsVerbatimArguments: true,
  timeout: 120000,
});
const executablePath = path.join(installed, 'CHAOS-Android-Preview.exe');
assert.ok((await fs.stat(executablePath)).size > 0);
const config = path.join(testRoot, 'config');
const { ELECTRON_RUN_AS_NODE: _nodeMode, ATLAS_CONFIG_PATH: _config, ...environment } = process.env;
let application;
async function launch() {
  application = await _electron.launch({
    executablePath,
    env: {
      ...environment,
      CHAOS_CONFIG_DIR: config,
      CHAOS_DESKTOP_USER_DATA: path.join(testRoot, 'browser'),
      ATLAS_PORT: '0',
    },
  });
  const page = await application.firstWindow();
  await expect(page.getByRole('navigation', { name: '手机导航' })).toBeVisible();
  return page;
}
const navigate = (page, name) =>
  page
    .getByRole('navigation', { name: '手机导航' })
    .getByRole('button', { name, exact: true })
    .click();
try {
  let page = await launch();
  const session = await page.request
    .get(new URL('/api/session', page.url()).href)
    .then((r) => r.json());
  assert.equal(session.root, path.join(config, 'sample-workspace'));
  // Windows fractional DPI can round the requested content width by a few pixels.
  const width = await page.evaluate(() => innerWidth);
  assert.ok(width >= 388 && width <= 394, `Unexpected preview width: ${width}`);
  assert.equal(await page.evaluate(() => typeof globalThis.require), 'undefined');
  assert.equal(await page.locator('.mobile-navigation button').count(), 6);
  await navigate(page, '工作空间');
  await page.getByRole('button', { name: '打开业务线 阶段报告', exact: true }).click();
  await expect(page.getByRole('heading', { name: '阶段报告', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: '完成 比较两组指标差异', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: '完成 比较两组指标差异', exact: true }),
  ).toBeChecked();
  await page.getByRole('button', { name: '下一条业务线' }).click();
  await expect(page.getByRole('heading', { name: '仿真与验证', exact: true })).toBeVisible();
  await navigate(page, '笔记');
  await page.getByRole('button', { name: '打开业务线 阶段报告', exact: true }).click();
  await page.getByLabel('随手记', { exact: true }).fill('安装后预览的笔记');
  await page.getByRole('button', { name: '记到笔记', exact: true }).click();
  await expect(page.getByLabel('随手记', { exact: true })).toHaveValue('');
  await navigate(page, '编辑');
  await page.getByLabel('具体事件', { exact: true }).fill('安装后预览的实际记录');
  await page.getByLabel('开始时间', { exact: true }).fill('10:00');
  await page.getByLabel('结束时间', { exact: true }).fill('11:00');
  await page.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(page.getByLabel('具体事件', { exact: true })).toHaveValue('');
  await navigate(page, '今日已做');
  await expect(page.getByText('安装后预览的实际记录', { exact: true })).toBeVisible();
  await navigate(page, '今日待做／待联系');
  await navigate(page, '回顾');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await fs.mkdir('test-results/android-preview', { recursive: true });
  await page.screenshot({ path: 'test-results/android-preview/installed.png' });
  await application.close();
  application = undefined;
  page = await launch();
  await navigate(page, '今日已做');
  await expect(page.getByText('安装后预览的实际记录', { exact: true })).toBeVisible();
  await navigate(page, '笔记');
  await page.getByRole('button', { name: '打开业务线 阶段报告', exact: true }).click();
  await expect(page.locator('.markdown-body')).toContainText('安装后预览的笔记');
} finally {
  await application?.close();
}
const unknown = path.join(installed, 'keep-my-file.txt');
await fs.writeFile(unknown, 'must survive uninstall');
execFileSync(path.join(installed, 'Uninstall.exe'), ['/S', `_?=${installed}`], {
  windowsHide: true,
  windowsVerbatimArguments: true,
  timeout: 60000,
});
assert.equal(await fs.readFile(unknown, 'utf8'), 'must survive uninstall');
assert.ok(await fs.stat(path.join(config, 'sample-workspace')));
await assert.rejects(fs.stat(executablePath));
console.log(
  'Android preview: silent installation, six pages, shared writes, isolated config, restart persistence and safe uninstall passed.',
);
