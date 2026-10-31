import { expect, test } from '@playwright/test';
import { connect, snapshot } from './helpers';

test.beforeEach(async ({ page }) => connect(page));

test('已连接目录自动填入设置，刷新后仍直接进入工作台', async ({ page }) => {
  const root = (await snapshot(page)).root;
  await page.getByRole('button', { name: '备份', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('工作目录绝对路径')).toHaveValue(root);
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('region', { name: '做了什么', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '备份', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('工作目录绝对路径')).toHaveValue(root);
});

test('恢复失败时保留默认路径和原因，可修改目录并重新连接', async ({ page }) => {
  const root = (await snapshot(page)).root;
  await page.route('**/api/session', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({
      response,
      json: {
        ...value,
        connected: false,
        root: root + '-missing',
        vaultId: '',
        connectionError: '无法恢复上次的工作目录：目录不存在',
      },
    });
  });
  await page.reload();
  await expect(page.getByLabel('工作目录绝对路径', { exact: true })).toHaveValue(root + '-missing');
  await expect(page.getByRole('alert')).toContainText('目录不存在');
  await page.unroute('**/api/session');
  await page.getByLabel('工作目录绝对路径', { exact: true }).fill(root);
  await page.getByRole('button', { name: '连接工作目录', exact: true }).click();
  await expect(page.getByRole('region', { name: '做了什么', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
