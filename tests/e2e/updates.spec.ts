import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { localDay, parseRecord, type Entry } from '../../packages/domain/index';

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

test('3 待办只填日期即可提前安排，今日跳转后可完成，节点日期不变', async ({ page }) => {
  const project = await write(page, 'project', { title: '项目' });
  const line = await write(page, 'workline', { title: '业务线', projectId: project.data.id });
  const point = await write(page, 'milestone', { title: '未来交付', lineId: line.data.id, dueDate: '2099-12-31', dueTime: '18:00' });
  const todo = await write(page, 'todo', { title: '提前准备', milestoneId: point.data.id });
  await refresh(page);
  await nav(page, '工作空间');
  const row = page.locator(`[data-space-id="${todo.data.id}"]`).first();
  await row.locator('.todo-title').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑待办', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('input[type="time"]')).toHaveCount(0);
  const date = dialog.getByLabel('待办日期（可选）', { exact: true });
  await expect(date).toHaveValue('');
  await date.fill(localDay());
  await dialog.getByRole('button', { name: '保存到 Vault', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText(localDay());
  const session = await page.request.get('/api/session').then((r) => r.json());
  const response = await page.request.get('/api/snapshot', { headers: { 'X-Atlas-Token': session.token, 'X-Atlas-Vault': session.vaultId } });
  expect(response.ok()).toBe(true);
  const snapshot = await response.json();
  const markdown = await fs.readFile(path.join(snapshot.root, todo.path), 'utf8');
  expect(markdown).toContain(localDay());
  expect(markdown).not.toContain('dueTime');
  expect(snapshot.entries.find((e: Entry) => e.data.id === point.data.id).data).toMatchObject({ dueDate: '2099-12-31', dueTime: '18:00' });
  await page.reload();
  await nav(page, '今日');
  const today = page.getByRole('region', { name: '当天待办', exact: true });
  await expect(today).toContainText('提前准备');
  await today.getByRole('button', { name: /提前准备/ }).click();
  await page.getByRole('checkbox', { name: '完成 提前准备', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '完成 提前准备', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: '调整日期 · 未来交付' })).toContainText('2099-12-31');
  await nav(page, '今日');
  await expect(today).not.toContainText('提前准备');
});

test('4 节点自动按日期时刻排列，未定靠右由右至左按创建顺序排列，改期立即重排', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 });
  const project = await write(page, 'project', { title: '项目' });
  const line = await write(page, 'workline', { title: '业务线', projectId: project.data.id });
  await write(page, 'milestone', { title: '上午', lineId: line.data.id, dueDate: '2026-10-25', dueTime: '09:00', order: 100 });
  await write(page, 'milestone', { title: '最早未定', lineId: line.data.id, createdAt: '2020-01-01T00:00:00Z' });
  await refresh(page);
  await nav(page, '工作空间');
  const track = page.getByRole('region', { name: '业务线 · 业务线', exact: true });
  const titles = track.locator('.point-title');
  await expect(titles).toHaveText(['上午', '最早未定']);
  const dated = await track.getByRole('article', { name: '关键节点 · 上午', exact: true }).boundingBox();
  const undated = await track.getByRole('article', { name: '关键节点 · 最早未定', exact: true }).boundingBox();
  expect(undated!.x - dated!.x - dated!.width).toBeGreaterThan(100);
  const add = await track.locator('.add-point').boundingBox();
  const lane = await track.locator('.track-points').boundingBox();
  expect(Math.abs(add!.x + add!.width - lane!.x - lane!.width)).toBeLessThan(2);
  expect(add!.x - undated!.x - undated!.width).toBeCloseTo(40, 0);
  await write(page, 'milestone', { title: '下午', lineId: line.data.id, dueDate: '2026-10-25', dueTime: '18:00', order: -100 });
  await write(page, 'milestone', { title: '后来未定', lineId: line.data.id, createdAt: '2020-01-02T00:00:00Z' });
  await refresh(page);
  await track.locator('.add-point').click();
  await page.getByLabel('标题', { exact: true }).fill('新建未定');
  await page.getByRole('button', { name: '保存到 Vault', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const order = ['上午', '下午', '新建未定', '后来未定', '最早未定'];
  await expect(titles).toHaveText(order);
  await page.getByRole('button', { name: '调整日期 · 后来未定', exact: true }).click();
  await page.getByLabel('截止日期', { exact: true }).fill('2026-10-24');
  await page.getByRole('button', { name: '保存到 Vault', exact: true }).click();
  await expect(titles).toHaveText(['后来未定', '上午', '下午', '新建未定', '最早未定']);
  await page.getByRole('button', { name: '调整日期 · 后来未定', exact: true }).click();
  await page.getByLabel('截止日期', { exact: true }).fill('');
  await page.getByRole('button', { name: '保存到 Vault', exact: true }).click();
  await expect(titles).toHaveText(order);
  await page.reload();
  await nav(page, '工作空间');
  await expect(titles).toHaveText(order);
  await page.screenshot({ path: '.test-vault/milestone-order-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 600, height: 1000 });
  await expect(titles).toHaveText(order);
  expect(await track.locator('.track-scroll').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
