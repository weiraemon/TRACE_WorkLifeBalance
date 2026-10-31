import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let desktop: ElectronApplication | undefined;
test.afterEach(async () => {
  await desktop?.close();
  desktop = undefined;
});

async function launch(root: string) {
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...environment } = process.env;
  desktop = await _electron.launch({
    executablePath: process.env.CHAOS_DESKTOP_EXECUTABLE || require('electron'),
    args: process.env.CHAOS_DESKTOP_EXECUTABLE ? [] : [path.resolve('.desktop')],
    env: {
      ...environment,
      ATLAS_PORT: '0',
      ATLAS_CONFIG_PATH: path.join(root, 'workspace.json'),
      CHAOS_CONFIG_DIR: path.join(root, 'config'),
      CHAOS_DESKTOP_USER_DATA: path.join(root, 'browser'),
    },
  });
  const page = await desktop.firstWindow();
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
  return page;
}

test('桌面版目录选择、四页、记录保存、完整 QQ 入口与安全隔离；退出释放锁并恢复目录', async () => {
  await fs.mkdir('.test-vault', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-vault/desktop-'));
  const vault = path.join(root, '中文工作目录 with spaces');
  await fs.mkdir(vault);
  let page = await launch(root);
  await desktop!.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [directory],
    })) as typeof dialog.showOpenDialog;
  }, vault);
  await page.getByRole('button', { name: '浏览文件夹…', exact: true }).click();
  await expect(page.getByLabel('工作目录绝对路径')).toHaveValue(vault);
  await page.getByRole('button', { name: '连接工作目录', exact: true }).click();
  const form = page.getByRole('form', { name: '实际工作录入', exact: true });
  await form.getByLabel('具体事件', { exact: true }).fill('Electron 中保存完整工作记录');
  await form.getByLabel('开始时间', { exact: true }).fill('10:00');
  await form.getByLabel('结束时间', { exact: true }).fill('11:00');
  await form.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(form.getByLabel('具体事件', { exact: true })).toHaveValue('');
  await expect(page.getByRole('region', { name: '当天实际记录', exact: true })).toContainText(
    'Electron 中保存完整工作记录',
  );
  for (const name of ['工作空间', '知识', '回顾', '今日']) {
    const navigation = page
      .getByRole('navigation', { name: '主导航', exact: true })
      .getByRole('button', { name, exact: true });
    await navigation.click();
    await expect(navigation).toHaveAttribute('aria-current', 'page');
  }
  expect(await desktop!.evaluate(({ Menu }) => Menu.getApplicationMenu())).toBeNull();
  expect(await page.evaluate(() => Object.keys(window.chaosDesktop ?? {}).sort())).toEqual([
    'chooseDirectory',
    'setupQq',
  ]);
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
    'undefined',
  );
  await page.getByRole('button', { name: '备份', exact: true }).click();
  await page.getByRole('button', { name: 'QQ同步设置', exact: true }).click();
  await page.getByRole('button', { name: 'QQ自动同步全局设置', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '初始化 QQ 数据库读取…', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Python 命令', { exact: true })).toHaveCount(0);
  await desktop!.close();
  desktop = undefined;
  await expect
    .poll(() =>
      fs.access(path.join(vault, '.atlas/service.lock')).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
  page = await launch(root);
  await expect(page.getByRole('region', { name: '当天实际记录', exact: true })).toContainText(
    'Electron 中保存完整工作记录',
  );
  await page.screenshot({ path: '.test-vault/chaos-desktop.png' });
});

test('内置 Python 原生 SQLCipher 可加密、重新打开并读取数据库', async () => {
  const appRoot = process.env.CHAOS_DESKTOP_EXECUTABLE
    ? path.join(path.dirname(process.env.CHAOS_DESKTOP_EXECUTABLE), 'resources', 'app')
    : '.desktop';
  const result = execFileSync(
    path.resolve(appRoot, 'runtime/python/python.exe'),
    [
      '-c',
      "import sqlcipher3,tempfile,os; p=tempfile.mktemp(); c=sqlcipher3.connect(p); c.execute(\"PRAGMA key='desktop-test'\"); c.execute('CREATE TABLE t(v)'); c.execute('INSERT INTO t VALUES(42)'); c.commit(); c.close(); c=sqlcipher3.connect(p); c.execute(\"PRAGMA key='desktop-test'\"); assert c.execute('SELECT v FROM t').fetchone()[0]==42; c.close(); os.unlink(p); print('SQLCipher OK')",
    ],
    { windowsHide: true, encoding: 'utf8' },
  );
  expect(result.trim()).toBe('SQLCipher OK');
});
