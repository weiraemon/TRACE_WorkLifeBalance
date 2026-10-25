import { expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  parseRecord,
  type Entry,
  type SaveOptions,
  type Snapshot,
  localDay,
} from '../../packages/domain/index';
export { localDay };
export async function connect(page: Page) {
  await fs.mkdir('.test-vault', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-vault/lines-'));
  await page.goto('/');
  const settings = page.getByRole('button', { name: /^(连接 Vault|Vault 与备份)$/ });
  await expect(settings).toBeVisible();
  await settings.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('工作目录绝对路径').fill(root);
  await dialog.getByRole('button', { name: '连接工作目录', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '从这里，继续今天。' })).toBeVisible();
}
export const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
export async function headers(page: Page) {
  const s = await page.request.get('/api/session').then((r) => r.json());
  return { 'X-Atlas-Token': s.token, 'X-Atlas-Vault': s.vaultId };
}
export async function snapshot(page: Page): Promise<Snapshot> {
  const response = await page.request.get('/api/snapshot', { headers: await headers(page) });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
export async function write(
  page: Page,
  type: string,
  fields: object,
  options?: SaveOptions,
): Promise<Entry> {
  const now = new Date().toISOString();
  const response = await page.request.post('/api/records', {
    headers: await headers(page),
    data: {
      data: parseRecord({
        schemaVersion: 1,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        type,
        ...fields,
      }),
      options,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
export async function refresh(page: Page) {
  const button = page.getByRole('button', { name: '重新加载 Vault', exact: true });
  await expect(button).toBeEnabled();
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/snapshot')),
    button.click(),
  ]);
  await expect(button).toBeEnabled();
}
export async function seed(page: Page) {
  const project = await write(page, 'project', { title: '科研项目' });
  const line = await write(page, 'workline', { title: '论文研究', projectId: project.data.id });
  const node = await write(page, 'milestone', {
    title: '方案会议',
    lineId: line.data.id,
    dueDate: localDay(),
    dueTime: '09:00',
    tags: ['会议'],
  });
  const todo = await write(page, 'todo', { title: '找人要材料', milestoneId: node.data.id });
  const idea = await write(page, 'todo', {
    title: '验证替代解释',
    milestoneId: node.data.id,
    kind: 'idea',
  });
  await refresh(page);
  return { project, line, node, todo, idea };
}
export async function notes(page: Page, lineId: string) {
  const s = await snapshot(page),
    line = s.entries.find((e) => e.data.id === lineId)!.data;
  if (line.type !== 'workline') throw new Error('不是业务线');
  const resource = s.entries.find((e) => e.data.id === line.notesId)!;
  return fs.readFile(path.join(s.root, resource.path), 'utf8');
}
