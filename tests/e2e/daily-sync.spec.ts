import { expect, test } from '@playwright/test';
import { connect, snapshot, write, nav, refresh } from './helpers';

test.use({ timezoneId: 'Asia/Shanghai' });

test('跨到11月3日自动隐藏11月1日已完成节点和池内条目，不修改原数据', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-02T23:58:00+08:00') });
  await connect(page);
  const project = await write(page, 'project', { title: '跨日项目' });
  const line = await write(page, 'workline', { title: '跨日线', projectId: project.data.id });
  const node = await write(page, 'milestone', {
    title: '11月1日已完成节点',
    lineId: line.data.id,
    dueDate: '2026-11-01',
    completedAt: new Date().toISOString(),
  });
  const pool = (await snapshot(page)).entries.find(
    ({ data }) => data.type === 'milestone' && data.lineId === line.data.id && data.pool,
  )!;
  const todo = await write(page, 'todo', {
    title: '11月1日已完成条目',
    milestoneId: pool.data.id,
    dueDate: '2026-11-01',
    completedAt: new Date().toISOString(),
  });
  await refresh(page);
  await nav(page, '工作空间');
  const board = page.locator('.workspace-content');
  const marker = board.locator(`[data-space-id="${node.data.id}"]`);
  const row = board.locator(`[data-space-id="${todo.data.id}"]`);
  await expect(marker).toHaveCount(1);
  await expect(row).toHaveCount(1);
  const before = (await snapshot(page)).entries;
  await page.clock.setSystemTime(new Date('2026-11-03T00:00:01+08:00'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(marker).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await page.getByLabel('显示较早已完成节点和条目', { exact: true }).check();
  await expect(marker).toHaveCount(1);
  await expect(row).toHaveCount(1);
  expect((await snapshot(page)).entries).toEqual(before);
});

test('午夜自动换日，空白记录更新时间，快速收集草稿保留', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-01T23:59:58+08:00') });
  await connect(page);
  const form = page.getByRole('form', { name: '实际工作录入', exact: true });
  await expect(page.getByLabel('查看日期', { exact: true })).toHaveValue('2026-11-01');
  await page.getByRole('tab', { name: '待办 / 节点', exact: true }).click();
  await page.getByLabel('要做什么', { exact: true }).fill('留到明天继续安排');
  await page.clock.fastForward(7000);
  await expect(page.getByLabel('查看日期', { exact: true })).toHaveValue('2026-11-02');
  await expect(page.getByLabel('要做什么', { exact: true })).toHaveValue('留到明天继续安排');
  await page.getByRole('tab', { name: '今日已做', exact: true }).click();
  await expect(form.locator('.capture-date')).toHaveText('记录日期 · 2026-11-02');
  await expect(page.getByRole('button', { name: '重新加载 Vault', exact: true })).toBeEnabled();
  await page.clock.setSystemTime(new Date('2026-11-02T10:45:00+08:00'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(form.getByLabel('开始时间', { exact: true })).toHaveValue('10:15');
  await expect(form.getByLabel('结束时间', { exact: true })).toHaveValue('10:45');
});

test('跨天保留实际记录草稿及原日期时间，保存后使用新日期', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-01T23:55:00+08:00') });
  await connect(page);
  const form = page.getByRole('form', { name: '实际工作录入', exact: true });
  await form.getByLabel('具体事件', { exact: true }).fill('昨天的实验尚未提交');
  await form.getByLabel('开始时间', { exact: true }).fill('22:00');
  await form.getByLabel('结束时间', { exact: true }).fill('23:00');
  await page.clock.setSystemTime(new Date('2026-11-02T09:00:00+08:00'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByLabel('查看日期', { exact: true })).toHaveValue('2026-11-02');
  await expect(form.getByLabel('具体事件', { exact: true })).toHaveValue('昨天的实验尚未提交');
  await expect(form.getByLabel('开始时间', { exact: true })).toHaveValue('22:00');
  await expect(form.getByLabel('结束时间', { exact: true })).toHaveValue('23:00');
  await expect(form.locator('.capture-date')).toContainText('正在记录历史日期');
  await expect(form.getByLabel('记录日期', { exact: true })).toHaveValue('2026-11-01');
  await form.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(form.getByLabel('具体事件', { exact: true })).toHaveValue('');
  expect(
    (await snapshot(page)).entries.find((entry) => entry.data.type === 'actual')?.data,
  ).toMatchObject({ date: '2026-11-01', startTime: '22:00', endTime: '23:00' });
  await expect(form.locator('.capture-date')).toHaveText('记录日期 · 2026-11-02');
});

test('唤醒后立即同步新增安排，手动选择的历史日期不跳走', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-01T10:00:00+08:00') });
  await connect(page);
  await page.clock.pauseAt(new Date('2026-11-01T10:00:01+08:00'));
  const project = await write(page, 'project', { title: '自动同步项目' });
  const line = await write(page, 'workline', { title: '自动同步线', projectId: project.data.id });
  await write(page, 'milestone', {
    title: '切回后看到的新安排',
    lineId: line.data.id,
    dueDate: '2026-11-01',
    dueTime: '11:00',
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page.getByRole('button', { name: '记一段 · 切回后看到的新安排', exact: true }),
  ).toBeVisible();
  await page.getByLabel('查看日期', { exact: true }).fill('2026-10-20');
  await page.clock.setSystemTime(new Date('2026-11-03T10:00:00+08:00'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('查看日期', { exact: true })).toHaveValue('2026-10-20');
});
