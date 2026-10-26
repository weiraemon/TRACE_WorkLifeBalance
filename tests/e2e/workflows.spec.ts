import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect, nav, seed, write, refresh, snapshot, notes, headers, localDay } from './helpers';
test.beforeEach(async ({ page }) => connect(page));

test('首页先写内容再绑定业务线，可快速创建 TODO / IDEA，不产生实际时间或今日计划', async ({
  page,
}) => {
  const { line } = await seed(page);
  await page.getByRole('button', { name: 'TODO / IDEA', exact: true }).click();
  const capture = page.getByRole('region', { name: '快速创建 TODO / IDEA' });
  for (const kind of ['idea', 'todo']) {
    await capture.getByLabel('要做什么', { exact: true }).fill('临时' + kind);
    await capture.getByLabel('类型', { exact: true }).selectOption(kind);
    await capture.getByLabel('业务线', { exact: true }).selectOption(line.data.id);
    await capture.getByRole('button', { name: '添加', exact: true }).click();
    await expect(capture.getByLabel('要做什么', { exact: true })).toHaveValue('');
  }
  const s = await snapshot(page),
    items = s.entries.filter((e) => e.data.type === 'todo' && e.data.title.startsWith('临时'));
  expect(items).toHaveLength(2);
  for (const item of items) {
    const pool = s.entries.find(
      (e) => e.data.id === (item.data as { milestoneId: string }).milestoneId,
    );
    expect(pool?.data).toMatchObject({ type: 'milestone', pool: true, lineId: line.data.id });
  }
  expect(s.entries.filter((e) => e.data.type === 'actual')).toHaveLength(0);
  await expect(page.getByRole('region', { name: '当天待办', exact: true })).not.toContainText(
    '临时',
  );
  expect(await notes(page, line.data.id)).not.toContain('临时');
});

test('实际表单新建条目与批注一起保存，取消草稿不留条目，完成只记录一个事实', async ({ page }) => {
  const { line } = await seed(page);
  let dialog = page.getByRole('form', { name: '实际工作录入', exact: true });
  let capture = dialog.getByRole('region', { name: '快速创建 TODO / IDEA' });
  await capture.getByLabel('要做什么', { exact: true }).fill('被取消的想法');
  await capture.getByLabel('业务线', { exact: true }).selectOption(line.data.id);
  await capture.getByRole('button', { name: '添加', exact: true }).click();
  await dialog.getByRole('button', { name: '清空', exact: true }).click();
  expect(
    (await snapshot(page)).entries.some(
      (e) => e.data.type === 'todo' && e.data.title === '被取消的想法',
    ),
  ).toBe(false);
  dialog = page.getByRole('form', { name: '实际工作录入', exact: true });
  await dialog.getByLabel('开始时间', { exact: true }).fill('10:00');
  await dialog.getByLabel('结束时间', { exact: true }).fill('11:00');
  await dialog.getByLabel('具体事件', { exact: true }).fill('比较两种解释');
  capture = dialog.getByRole('region', { name: '快速创建 TODO / IDEA' });
  await capture.getByLabel('要做什么', { exact: true }).fill('检查样本分布');
  await capture.getByLabel('业务线', { exact: true }).selectOption(line.data.id);
  await capture.getByLabel('批注', { exact: true }).fill('原解释不能覆盖异常样本');
  await capture.getByRole('button', { name: '添加', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '本次完成 检查样本分布', exact: true }).check();
  await dialog.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(dialog.getByLabel('具体事件', { exact: true })).toHaveValue('');
  const s = await snapshot(page),
    item = s.entries.find((e) => e.data.type === 'todo' && e.data.title === '检查样本分布')!.data;
  expect(item).toHaveProperty('completedAt', expect.any(String));
  const actual = s.entries.find((e) => e.data.type === 'actual')!.data;
  expect(actual).toMatchObject({ itemIds: [item.id], description: '比较两种解释' });
  expect(actual).not.toHaveProperty('history');
  const text = await notes(page, line.data.id);
  expect(text.split('原解释不能覆盖异常样本')).toHaveLength(2);
});

test('首页已有条目右键批注写入 Notes，完成不添加纪要，节点自动完成不连带业务线', async ({
  page,
}) => {
  const { line, node, todo, idea } = await seed(page);
  const row = page.locator(`[data-space-id="${idea.data.id}"]`).first();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '添加批注', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('批注 / 纪要', { exact: true }).fill('下一步先排除测量误差');
  await dialog.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const before = await notes(page, line.data.id);
  await page.getByRole('checkbox', { name: '完成 找人要材料', exact: true }).click();
  await page.getByRole('checkbox', { name: '完成 验证替代解释', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: '完成 验证替代解释', exact: true }),
  ).toBeChecked();
  expect(await notes(page, line.data.id)).toBe(before);
  await nav(page, '工作空间');
  await expect(
    page.getByRole('checkbox', { name: '完成节点 方案会议', exact: true }),
  ).toBeChecked();
  await expect(page.getByRole('region', { name: '业务线 · 论文研究', exact: true })).toBeVisible();
  expect(
    (await snapshot(page)).entries.find((e) => e.data.id === line.data.id)?.data,
  ).toHaveProperty('completedAt', null);
});

for (const kind of ['todo', 'idea', 'node'])
  test(`${kind} 一步升为平级业务线，移动 Notes，不保留来源关联`, async ({ page }) => {
    const { line, node, todo, idea } = await seed(page);
    const target = kind === 'todo' ? todo : kind === 'idea' ? idea : node;
    const response = await page.request.post('/api/records', {
      headers: await headers(page),
      data: {
        data: target.data,
        revision: target.revision,
        options: {
          comments: [
            { id: randomUUID(), targetId: target.data.id, text: '需要移到新线的实质内容' },
          ],
        },
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    await refresh(page);
    await nav(page, '工作空间');
    await page.locator(`[data-space-id="${target.data.id}"]`).first().click({ button: 'right' });
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/promote') && r.request().method() === 'POST',
      ),
      page.getByRole('menuitem', { name: '升级为业务线', exact: true }).click(),
    ]);
    await expect(
      page.getByRole('region', {
        name: `业务线 · ${'title' in target.data ? target.data.title : ''}`,
        exact: true,
      }),
    ).toBeVisible();
    const s = await snapshot(page),
      promoted = s.entries.find((e) => e.data.id === target.data.id)!.data;
    expect(promoted.type).toBe('workline');
    expect(promoted).not.toHaveProperty('milestoneId');
    expect(promoted).not.toHaveProperty('lineId');
    expect(promoted).not.toHaveProperty('sourceId');
    expect(await notes(page, promoted.id)).toContain('需要移到新线');
    expect(await notes(page, line.data.id)).not.toContain('需要移到新线');
  });

test('节点和条目快速删除，业务线删除额外确认，保留纪要与实际时间', async ({ page }) => {
  const { line, node, todo } = await seed(page);
  await write(page, 'actual', {
    date: localDay(),
    startTime: '10:00',
    endTime: '11:00',
    description: '保留的实际时间',
    itemIds: [todo.data.id],
  });
  await refresh(page);
  await nav(page, '工作空间');
  await page.locator(`[data-space-id="${todo.data.id}"]`).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除条目', exact: true }).click();
  await expect(page.locator(`[data-space-id="${todo.data.id}"]`)).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page
    .locator(`.workspace-content [data-space-id="${line.data.id}"]`)
    .locator('.line-title')
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除业务线', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('删除不可撤销');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('region', { name: '业务线 · 论文研究', exact: true })).toBeVisible();
  const s = await snapshot(page);
  expect(s.entries.find((e) => e.data.type === 'actual')?.data).toMatchObject({
    itemIds: [],
    description: '保留的实际时间',
  });
  await page
    .locator(`[data-space-id="${node.data.id}"]`)
    .first()
    .locator('.point-title')
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除节点', exact: true }).click();
  await expect(page.locator(`[data-space-id="${node.data.id}"]`)).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '业务线 · 论文研究', exact: true })).toBeVisible();
});

test('业务线手动完成后收起，下属未完成条目不被连带划掉，可明确重新打开', async ({ page }) => {
  const { line, todo } = await seed(page);
  await nav(page, '工作空间');
  const track = page.getByRole('region', { name: '业务线 · 论文研究', exact: true });
  await track.locator('.line-title').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '完成业务线', exact: true }).click();
  await expect(track).toHaveCount(0);
  let s = await snapshot(page);
  expect(s.entries.find((e) => e.data.id === line.data.id)?.data).toHaveProperty(
    'completedAt',
    expect.any(String),
  );
  expect(s.entries.find((e) => e.data.id === todo.data.id)?.data).toHaveProperty(
    'completedAt',
    null,
  );
  await page.getByRole('checkbox', { name: '显示已完成项目 / 业务线', exact: true }).check();
  await expect(track).toBeVisible();
  await track.locator('.line-title').click({ button: 'right' });
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/records') && response.request().method() === 'POST',
    ),
    page.getByRole('menuitem', { name: '重新打开业务线', exact: true }).click(),
  ]);
  await expect(track).toBeVisible();
  s = await snapshot(page);
  expect(s.entries.find((e) => e.data.id === line.data.id)?.data).toHaveProperty(
    'completedAt',
    null,
  );
});

test('节点创建时写纪要和新标签，Notes 包含日期与名称；无状态选择', async ({ page }) => {
  const { line } = await seed(page);
  await nav(page, '工作空间');
  const track = page.getByRole('region', { name: '业务线 · 论文研究', exact: true });
  await track.locator('.add-point').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('标题', { exact: true }).fill('新实验');
  await dialog.getByText('可选设置', { exact: true }).click();
  await dialog.getByLabel('截止日期', { exact: true }).fill('2026-11-01');
  await dialog.getByLabel('截止时刻', { exact: true }).fill('15:30');
  await dialog.getByLabel('节点标签', { exact: true }).fill('实验，新方向');
  await dialog.getByLabel('批注 / 纪要', { exact: true }).fill('实验安排：先做基线，再改参数');
  await expect(dialog.getByLabel('状态', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const content = await notes(page, line.data.id);
  expect(content).toContain('2026-11-01 15:30 · 新实验');
  expect(content).toContain('实验安排');
  await expect(track.locator('.node-tags').filter({ hasText: '新方向' })).toBeVisible();
});

test('Notes 保存外部修改冲突保留草稿，界面窄屏不横向溢出', async ({ page }) => {
  const { line } = await seed(page);
  await nav(page, '工作空间');
  await page
    .getByRole('region', { name: '业务线 · 论文研究', exact: true })
    .locator('.line-title')
    .first()
    .click();
  const detail = page.getByRole('complementary', { name: '工作详情' });
  await expect(detail.getByRole('button', { name: '编辑正文', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '编辑正文', exact: true }).click();
  const input = detail.getByLabel('Notes 正文', { exact: true });
  await input.fill('网页未保存草稿');
  const s = await snapshot(page),
    l = s.entries.find((e) => e.data.id === line.data.id)!.data;
  if (l.type !== 'workline') throw new Error();
  const resource = s.entries.find((e) => e.data.id === l.notesId)!;
  await fs.appendFile(path.join(s.root, resource.path), '\n外部新增正文');
  await detail.getByRole('button', { name: '保存正文', exact: true }).click();
  await expect(detail.getByRole('alert')).toContainText('外部修改');
  await expect(input).toHaveValue('网页未保存草稿');
  page.once('dialog', (dialog) => dialog.accept());
  await detail.getByRole('button', { name: '取消', exact: true }).click();
  await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.setViewportSize({ width: 600, height: 1000 });
  await nav(page, '今日');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.test-vault/today-lines-mobile.png', fullPage: true });
});

test('API 仍拒绝无会话、跨目录会话、非法路径与未定义接口', async ({ page }) => {
  expect((await page.request.get('/api/snapshot')).status()).toBe(403);
  expect(
    (
      await page.request.get('/api/snapshot', {
        headers: { ...(await headers(page)), 'X-Atlas-Vault': 'other-session' },
      })
    ).status(),
  ).toBe(409);
  const response = await page.request.post('/api/records', {
    headers: await headers(page),
    data: { data: { type: 'project', status: 'Ready' } },
  });
  expect(response.status()).toBe(400);
  expect(
    (
      await page.request.post('/api/milestone-content', { headers: await headers(page), data: {} })
    ).status(),
  ).toBe(404);
});
