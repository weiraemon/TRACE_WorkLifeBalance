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

async function seed(page: Page) {
  const project = await write(page, 'project', { title: '项目' });
  const line = await write(page, 'workline', { title: '业务线', projectId: project.data.id });
  const point = await write(page, 'milestone', { title: '节点', lineId: line.data.id });
  const todo = await write(page, 'todo', { title: '待办', milestoneId: point.data.id });
  await refresh(page);
  return { project, line, point, todo };
}

test('2 四层实体只有右键通用编辑，日期和颜色快捷编辑保留', async ({ page }) => {
  const { project, line, point, todo } = await seed(page);
  await nav(page, '工作空间');
  await page.getByRole('button', { name: /查看节点 节点/ }).click();
  const detail = page.getByRole('complementary', { name: '工作详情' });
  await expect(detail.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '编辑项目 项目', exact: true })).toHaveCount(0);
  for (const [entry, selector, label] of [
    [project, '.plane-toggle', '项目'], [line, '.track-heading > button:first-child', '业务线'],
    [point, '.point-title', '关键节点'], [todo, '.todo-title', '待办'],
  ] as const) {
    const target = page.locator(`[data-space-id="${entry.data.id}"]`).first().locator(selector);
    await target.click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveCount(2);
    await expect(menu.getByRole('menuitem', { name: `编辑${label}`, exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: `删除${label}`, exact: true })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: `编辑${label}`, exact: true })).toBeVisible();
    await page.getByLabel('标题', { exact: true }).fill(label + '改名');
    await page.getByRole('button', { name: '保存到 Vault', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(target).toContainText(label + '改名');
  }
  await detail.getByRole('heading', { name: '关键节点改名', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '编辑关键节点' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '调整日期 · 关键节点改名' }).click();
  await expect(page.getByRole('heading', { name: '编辑关键节点', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '编辑重要性 · 业务线改名' }).click();
  await expect(page.getByRole('heading', { name: '编辑业务线', exact: true })).toBeVisible();
});
