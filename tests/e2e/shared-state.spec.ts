import { test, expect, type Route } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { recordContract } from '../../packages/domain/index';
import { connect, write, refresh, snapshot, headers, localDay, nav, notes } from './helpers';

test.beforeEach(async ({ page }) => connect(page));

for (const children of [false, true]) {
  test(`今日已做完成例会后立即置底，工作空间状态一致（含条目=${children}）`, async ({ page }) => {
    const project = await write(page, 'project', { title: '共享状态项目' });
    const line = await write(page, 'workline', { title: '日常工作', projectId: project.data.id });
    const meeting = await write(page, 'milestone', {
      title: '例会',
      lineId: line.data.id,
      dueDate: localDay(),
      dueTime: '09:00',
      importance: 4,
    });
    await write(page, 'milestone', {
      title: '后续安排',
      lineId: line.data.id,
      dueDate: localDay(),
      dueTime: '11:00',
    });
    if (children) await write(page, 'todo', { title: '会议事项', milestoneId: meeting.data.id });
    await refresh(page);
    await page.getByRole('button', { name: '记一段 · 例会', exact: true }).click();
    const form = page.getByRole('form', { name: '实际工作录入', exact: true });
    await form.getByRole('checkbox', { name: '本次完成节点 例会', exact: true }).check();
    await form.getByLabel('具体事件', { exact: true }).fill('完成例会');
    await form.getByLabel('开始时间', { exact: true }).fill('09:00');
    await form.getByLabel('结束时间', { exact: true }).fill('09:30');
    await form.getByRole('button', { name: '保存实际工作', exact: true }).click();
    await expect(form.getByLabel('具体事件', { exact: true })).toHaveValue('');
    await expect(page.getByRole('checkbox', { name: '完成节点 例会', exact: true })).toBeChecked();
    await expect(page.locator('.today-todos > li').first()).toContainText('后续安排');
    await nav(page, '工作空间');
    await expect(page.getByRole('checkbox', { name: '完成节点 例会', exact: true })).toBeChecked();
  });
}

test('迟到的旧快照不能覆盖实际完成、重要性、日期属性和 Notes 的新结果', async ({ page }) => {
  const project = await write(page, 'project', { title: '共享状态项目' });
  const line = await write(page, 'workline', { title: '日常工作', projectId: project.data.id });
  const meeting = await write(page, 'milestone', {
    title: '例会',
    lineId: line.data.id,
    dueDate: localDay(),
    dueTime: '09:00',
  });
  await write(page, 'milestone', {
    title: '后续安排',
    lineId: line.data.id,
    dueDate: localDay(),
    dueTime: '11:00',
  });
  await refresh(page);
  const before = await snapshot(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  let held: Route | undefined;
  let received!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route('**/api/business/v1/workspace', async (route) => {
    if (!held) {
      held = route;
      received();
    } else await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await intercepted;
  const response = await page.request.post('/api/business/v1/commands', {
    headers: await headers(page),
    data: {
      type: 'record.save',
      data: { ...meeting.data, importance: 5, dueTime: '09:15' },
      revision: meeting.revision,
    },
  });
  expect(response.ok()).toBe(true);
  await page.getByRole('button', { name: '记一段 · 例会', exact: true }).click();
  const form = page.getByRole('form', { name: '实际工作录入', exact: true });
  await form.getByRole('checkbox', { name: '本次完成节点 例会', exact: true }).check();
  await form.getByLabel('批注 · 例会', { exact: true }).fill('唯一一份会议结论');
  await form.getByLabel('具体事件', { exact: true }).fill('完成例会');
  await form.getByLabel('开始时间', { exact: true }).fill('09:00');
  await form.getByLabel('结束时间', { exact: true }).fill('09:30');
  await form.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(form.getByLabel('具体事件', { exact: true })).toHaveValue('');
  const checkbox = page.getByRole('checkbox', { name: '完成节点 例会', exact: true });
  await expect(checkbox).toBeChecked();
  const delayedResponse = page.waitForResponse((r) =>
    r.url().endsWith('/api/business/v1/workspace'),
  );
  await held!.fulfill({
    contentType: 'application/json',
    headers: { 'X-Atlas-Contract': recordContract },
    json: { version: '1', snapshot: before },
  });
  await (await delayedResponse).finished();
  await page.clock.runFor(200);
  expect(await checkbox.getAttribute('aria-checked')).toBe('true');
  expect(await checkbox.getAttribute('class')).toContain('priority-5');
  expect(
    await page.locator(`.today-todos > [data-space-id="${meeting.data.id}"] time`).textContent(),
  ).toBe('09:15');
  expect(await page.locator('.today-todos > li').first().textContent()).toContain('后续安排');
  expect((await notes(page, line.data.id)).split('唯一一份会议结论')).toHaveLength(2);
});

test('切换工作目录后，旧目录的迟到响应不能把界面切回去', async ({ page }) => {
  await write(page, 'project', { title: '旧目录中的项目' });
  await refresh(page);
  const before = await snapshot(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  let held: Route | undefined;
  let received!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route('**/api/business/v1/workspace', async (route) => {
    if (!held) {
      held = route;
      received();
    } else await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await intercepted;
  const next = await fs.mkdtemp(path.resolve('.test-vault/shared-connect-'));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('工作目录绝对路径').fill(next);
  await dialog.getByRole('button', { name: '连接工作目录', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const delayedResponse = page.waitForResponse((r) =>
    r.url().endsWith('/api/business/v1/workspace'),
  );
  await held!.fulfill({
    contentType: 'application/json',
    headers: { 'X-Atlas-Contract': recordContract },
    json: { version: '1', snapshot: before },
  });
  await (await delayedResponse).finished();
  await page.clock.runFor(200);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  expect(await dialog.getByLabel('工作目录绝对路径').inputValue()).toBe(next);
});
