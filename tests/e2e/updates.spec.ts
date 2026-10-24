import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseRecord, type Entry } from '../../packages/domain/index';

test.beforeEach(async ({ page }) => {
  await fs.mkdir('.test-vault', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-vault/updates-'));
  await page.goto('/');
  if (await page.getByRole('button', { name: 'Vault 与备份', exact: true }).count())
    await page.getByRole('button', { name: 'Vault 与备份', exact: true }).click();
  await page.getByLabel('Vault 绝对路径').fill(root);
  await page.getByRole('button', { name: '连接本地 Vault', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Vault 与备份', exact: true })).toBeVisible();
});
async function write(page: Page, type: string, fields: object): Promise<Entry> {
  const session = await page.request.get('/api/session').then((r) => r.json());
  const now = new Date().toISOString();
  const data = parseRecord({ schemaVersion: 1, id: randomUUID(), type, createdAt: now, updatedAt: now, ...fields });
  const response = await page.request.post('/api/records', {
    headers: { 'X-Atlas-Token': session.token, 'X-Atlas-Vault': session.vaultId }, data: { data },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
const nav = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
async function refresh(page: Page) {
  const button = page.getByRole('button', { name: '重新加载 Vault' });
  await expect(button).toBeEnabled();
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/snapshot')), button.click()]);
  await expect(button).toBeEnabled();
}

test('1 只有三份手动快照，删除无逐次撤销，手动快照可恢复', async ({ page }) => {
  await write(page, 'project', { title: '测试项目' });
  await refresh(page);
  await page.getByRole('button', { name: 'Vault 与备份', exact: true }).click();
  const dialog = page.getByRole('dialog');
  for (let i = 0; i < 4; i++) {
    await dialog.getByRole('button', { name: '创建管理数据快照', exact: true }).click();
    await expect(dialog.locator('.backup-row')).toHaveCount(Math.min(i + 1, 3));
    await expect(dialog.getByRole('button', { name: '创建管理数据快照', exact: true })).toBeEnabled();
  }
  await expect(dialog.getByRole('button', { name: '清理旧备份' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭对话框' }).click();
  await nav(page, '工作空间');
  await page.getByRole('button', { name: '收缩项目 测试项目' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除项目' }).click();
  await expect(dialog).toContainText('删除不可撤销');
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('region', { name: '项目面 · 测试项目' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '撤销删除' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Vault 与备份', exact: true }).click();
  await expect(dialog.locator('.backup-row')).toHaveCount(3);
  page.once('dialog', (value) => value.accept());
  await dialog.getByRole('button', { name: '恢复', exact: true }).first().click();
  await expect(dialog.getByRole('status')).toContainText('已恢复 1');
  await expect(dialog.locator('.backup-row')).toHaveCount(3);
});
