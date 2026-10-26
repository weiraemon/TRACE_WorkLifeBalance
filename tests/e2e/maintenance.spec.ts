import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { connect, seed, write, refresh, nav, snapshot, notes, headers, localDay } from './helpers';
import { recordContract } from '../../packages/domain/index';

test.beforeEach(async ({ page }) => connect(page));
const day = (offset: number) => {
  const date = new Date(localDay() + 'T12:00:00');
  date.setDate(date.getDate() + offset);
  return localDay(date);
};

test('逾期待办先提示，顺延保留原节点；越过节点日期进入本线池，批注保留', async ({ page }) => {
  const { line, node } = await seed(page);
  const oldNode = await write(page, 'milestone', {
    title: '昨天节点',
    lineId: line.data.id,
    dueDate: day(-1),
  });
  const futureNode = await write(page, 'milestone', {
    title: '后天截止',
    lineId: line.data.id,
    dueDate: day(2),
  });
  const id = randomUUID();
  const old = await write(
    page,
    'todo',
    { id, title: '越过原节点', milestoneId: oldNode.data.id },
    {
      comments: [{ id: randomUUID(), targetId: id, text: '保留这段推进批注' }],
    },
  );
  const early = await write(page, 'todo', {
    title: '节点前顺延',
    milestoneId: futureNode.data.id,
    dueDate: day(-1),
  });
  await write(page, 'todo', {
    title: '已完成不提示',
    milestoneId: oldNode.data.id,
    completedAt: new Date().toISOString(),
  });
  await write(page, 'todo', { title: '灵感不催办', kind: 'idea', milestoneId: oldNode.data.id });
  await write(page, 'todo', { title: '未来不混入', milestoneId: node.data.id, dueDate: day(1) });
  await refresh(page);
  const prompt = page.locator('.overdue-prompt');
  await expect(prompt).toContainText('2 项待办已过期');
  await prompt.getByRole('button', { name: '处理', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.overdue-list li')).toHaveCount(2);
  await dialog.getByRole('button', { name: '暂不处理', exact: true }).click();
  expect(
    (await snapshot(page)).entries.find((e) => e.data.id === old.data.id)?.data,
  ).toHaveProperty('dueDate', null);
  await prompt.getByRole('button', { name: '处理', exact: true }).click();
  await dialog.getByRole('button', { name: '全部挪到今天', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(prompt).toHaveCount(0);
  const state = await snapshot(page);
  const pool = state.entries.find(
    (e) => e.data.type === 'milestone' && e.data.lineId === line.data.id && e.data.pool,
  )!;
  expect(state.entries.find((e) => e.data.id === old.data.id)?.data).toMatchObject({
    dueDate: localDay(),
    milestoneId: pool.data.id,
  });
  expect(state.entries.find((e) => e.data.id === early.data.id)?.data).toMatchObject({
    dueDate: localDay(),
    milestoneId: futureNode.data.id,
  });
  const body = await notes(page, line.data.id);
  expect(body.match(/保留这段推进批注/g)).toHaveLength(1);
  expect(
    (
      await page.request.post('/api/content', {
        headers: await headers(page),
        data: { action: 'read', id: pool.data.id },
      })
    ).ok(),
  ).toBe(true);
  await expect(page.getByRole('region', { name: '当天待办', exact: true })).toContainText(
    '越过原节点',
  );
});

test('批量删除只处理过期未完成 TODO，保留 Notes 正文与实际记录', async ({ page }) => {
  const { line } = await seed(page);
  const node = await write(page, 'milestone', {
    title: '已过期节点',
    lineId: line.data.id,
    dueDate: day(-2),
  });
  const id = randomUUID();
  await write(
    page,
    'todo',
    { id, title: '失效待办', milestoneId: node.data.id },
    {
      comments: [{ id: randomUUID(), targetId: id, text: '删除待办也保留的内容' }],
    },
  );
  const idea = await write(page, 'todo', {
    title: '保留探索',
    kind: 'idea',
    milestoneId: node.data.id,
  });
  const actual = await write(page, 'actual', {
    date: day(-2),
    startTime: '09:00',
    endTime: '10:00',
    description: '实际投入',
    itemIds: [id],
  });
  await refresh(page);
  await page.locator('.overdue-prompt').getByRole('button', { name: '处理', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '全部删除', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const state = await snapshot(page);
  expect(state.entries.some((e) => e.data.id === id)).toBe(false);
  expect(state.entries.some((e) => e.data.id === idea.data.id)).toBe(true);
  expect(state.entries.find((e) => e.data.id === actual.data.id)?.data).toMatchObject({
    description: '实际投入',
    itemIds: [],
  });
  expect(await notes(page, line.data.id)).toContain('删除待办也保留的内容');
});

test('批量顺延部分失败后刷新剩余项，可重试且不覆盖更改', async ({ page }) => {
  const { line } = await seed(page);
  const node = await write(page, 'milestone', {
    title: '过期节点',
    lineId: line.data.id,
    dueDate: day(-1),
  });
  for (const title of ['第一项', '第二项'])
    await write(page, 'todo', { title, milestoneId: node.data.id });
  await refresh(page);
  let attempts = 0;
  await page.route('**/api/records', async (route) => {
    if (++attempts === 2)
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        headers: { 'X-Atlas-Contract': recordContract },
        body: JSON.stringify({ error: '文件已更改，请重新加载' }),
      });
    else await route.continue();
  });
  await page.locator('.overdue-prompt').getByRole('button', { name: '处理', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '全部挪到今天', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('已处理 1 项');
  await expect(dialog.locator('.overdue-list li')).toHaveCount(1);
  await page.unroute('**/api/records');
  await dialog.getByRole('button', { name: '全部挪到今天', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.overdue-prompt')).toHaveCount(0);
});

test('删除前待办被其他窗口完成时停止，不删除更新后的内容', async ({ page }) => {
  const { line } = await seed(page);
  const node = await write(page, 'milestone', {
    title: '旧节点',
    lineId: line.data.id,
    dueDate: day(-1),
  });
  const todo = await write(page, 'todo', { title: '正在其他窗口完成', milestoneId: node.data.id });
  await refresh(page);
  await page.locator('.overdue-prompt').getByRole('button', { name: '处理', exact: true }).click();
  await page.route('**/api/delete-preview', async (route) => {
    const response = await page.request.post('/api/records', {
      headers: await headers(page),
      data: { data: todo.data, revision: todo.revision, options: { completion: true } },
    });
    expect(response.ok()).toBe(true);
    await route.continue();
  });
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '全部删除', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('未删除更改后的待办');
  const updated = (await snapshot(page)).entries.find((e) => e.data.id === todo.data.id);
  expect(updated).toBeDefined();
  expect(updated?.data).toHaveProperty('completedAt', expect.any(String));
});

test('静蓝主题覆盖各页并记住选择，切换不改变数据或重要性颜色', async ({ page }) => {
  await seed(page);
  const before = await snapshot(page);
  const palette = () =>
    page.evaluate(() => ({
      background: getComputedStyle(document.documentElement).backgroundColor,
      priority: getComputedStyle(document.querySelector('.priority-1')!)
        .getPropertyValue('--priority-color')
        .trim(),
    }));
  expect((await palette()).background).toBe('rgb(248, 246, 239)');
  const settings = page.getByRole('button', { name: '备份', exact: true });
  await settings.click();
  await page
    .getByRole('region', { name: '主题', exact: true })
    .getByRole('button', { name: '静蓝', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'blue');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  expect(await palette()).toEqual({ background: 'rgb(241, 245, 248)', priority: '#21864d' });
  await page.screenshot({ path: '.test-vault/theme-blue-today.png', fullPage: true });
  await nav(page, '工作空间');
  await page.screenshot({ path: '.test-vault/theme-blue-workspace.png', fullPage: true });
  await nav(page, '知识');
  await page.getByRole('button', { name: '定位业务线 · 论文研究', exact: true }).click();
  await expect(page.getByRole('region', { name: '业务线 Notes', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'blue');
  await expect(page.getByRole('region', { name: '做了什么', exact: true })).toBeVisible();
  expect((await snapshot(page)).entries).toEqual(before.entries);
  await settings.click();
  await page
    .getByRole('region', { name: '主题', exact: true })
    .getByRole('button', { name: '暖绿', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'sage');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  expect((await palette()).background).toBe('rgb(248, 246, 239)');
});

test('清理后的周复盘表单仍可创建与编辑', async ({ page }) => {
  await nav(page, '回顾');
  await page.getByRole('button', { name: '写周复盘', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('本周进展', { exact: true }).fill('完成本周重点');
  await dialog.getByText('再多写一点（可选）', { exact: true }).click();
  await dialog.getByLabel('本周主线', { exact: true }).fill('论文研究');
  await dialog.getByLabel('下周继续什么', { exact: true }).fill('验证结论');
  await dialog.getByRole('button', { name: '保存到 Vault', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.locator('.review-note').click();
  await expect(dialog.getByLabel('本周进展', { exact: true })).toHaveValue('完成本周重点');
  await dialog.getByLabel('本周进展', { exact: true }).fill('补充本周结果');
  await dialog.getByRole('button', { name: '保存到 Vault', exact: true }).click();
  await expect(page.locator('.review-note')).toContainText('补充本周结果');
  expect((await snapshot(page)).entries.filter((e) => e.data.type === 'review')).toHaveLength(1);
});
