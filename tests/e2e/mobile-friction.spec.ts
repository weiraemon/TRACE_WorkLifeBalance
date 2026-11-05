import { expect, test } from '@playwright/test';
import { connect, seed, write, snapshot, headers, localDay, notes } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test.beforeEach(async ({ page }) => {
  await connect(page);
  await seed(page);
  await page.goto('/?ui=android');
  await expect(page.getByRole('navigation', { name: '手机导航' })).toBeVisible();
});
const nav = (page: import('@playwright/test').Page, name: string) =>
  page
    .getByRole('navigation', { name: '手机导航' })
    .getByRole('button', { name, exact: true })
    .click();

test('实际正文、时间、关联和批注跨页面、录入类型、刷新及网页入口保留', async ({ page }) => {
  await nav(page, '编辑');
  await page.getByLabel('具体事件', { exact: true }).fill('应当留存的实际草稿');
  await page.getByLabel('开始时间', { exact: true }).fill('08:15');
  await expect(page.getByLabel('结束时间', { exact: true })).toHaveAttribute('type', 'time');
  await page.getByLabel('结束时间', { exact: true }).fill('09:15');
  await page
    .locator('.actual-pool-choice')
    .filter({ hasText: '找人要材料' })
    .getByRole('button', { name: '加入', exact: true })
    .click();
  await page.getByLabel('批注 · 找人要材料', { exact: true }).fill('关联批注也要保留');
  await page.getByRole('button', { name: '待办／节点', exact: true }).click();
  await page.getByLabel('要做什么', { exact: true }).fill('另一个收集草稿');
  await nav(page, '今日已做');
  await nav(page, '编辑');
  await expect(page.getByLabel('要做什么', { exact: true })).toHaveValue('另一个收集草稿');
  await page.getByRole('button', { name: '实际工作', exact: true }).click();
  await expect(page.getByLabel('具体事件', { exact: true })).toHaveValue('应当留存的实际草稿');
  await page.reload();
  await nav(page, '编辑');
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('08:15');
  await expect(page.getByLabel('结束时间', { exact: true })).toHaveValue('09:15');
  await expect(page.getByLabel('批注 · 找人要材料', { exact: true })).toHaveValue(
    '关联批注也要保留',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByLabel('具体事件', { exact: true })).toHaveValue('应当留存的实际草稿');
  await expect(page.getByLabel('结束时间', { exact: true })).toHaveAttribute('type', 'time');
});

test('过期事件完整滚动，改期等待中可用 Android 返回键关闭', async ({ page }) => {
  const data = await snapshot(page);
  const line = data.entries.find((entry) => entry.data.type === 'workline')!;
  for (let i = 0; i < 12; i++)
    await write(page, 'milestone', {
      title: `过期节点 ${i}`,
      lineId: line.data.id,
      dueDate: '2026-01-01',
    });
  await page.reload();
  await page
    .getByRole('status')
    .filter({ hasText: '过期事件' })
    .getByRole('button', { name: '查看', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('.overdue-event-list li').last().scrollIntoViewIfNeeded();
  const last = await dialog.locator('.overdue-event-list li').last().boundingBox();
  expect(last!.y + last!.height).toBeLessThanOrEqual(844);
  await expect(dialog.locator('.overdue-event-list')).toHaveCSS('overflow-y', 'visible');
  await page.route('**/api/business/v1/commands', async (route) => {
    if (route.request().postDataJSON().type === 'record.save')
      await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  await dialog.getByRole('button', { name: '今日', exact: true }).last().click();
  await page.evaluate(() => window.dispatchEvent(new Event('chaos-back')));
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '今日导航', exact: true })).toBeVisible();
  await page.waitForTimeout(1500);
});

test('业务线入口的识别保持归属，待选节点按当天优先且删除后移除', async ({ page }) => {
  const data = await snapshot(page);
  const line = data.entries.find((entry) => entry.data.type === 'workline')!;
  const todayNode = await write(page, 'milestone', {
    title: '今日优先节点',
    lineId: line.data.id,
    dueDate: localDay(),
    dueTime: '01:00',
  });
  await write(page, 'milestone', {
    title: '将来节点',
    lineId: line.data.id,
    dueDate: '2099-01-01',
  });
  const project = await write(page, 'project', { title: '其他项目' });
  await write(page, 'workline', { title: '其他业务', projectId: project.data.id });
  await page.reload();
  await nav(page, '工作空间');
  await page.getByRole('button', { name: '打开业务线 论文研究', exact: true }).click();
  await page.getByRole('button', { name: '添加节点', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const projectId = await dialog.getByLabel('所属项目', { exact: true }).inputValue();
  await dialog.getByLabel('粘贴微信消息', { exact: true }).fill('明天下午三点开会');
  await dialog.getByRole('button', { name: '识别时间和节点', exact: true }).click();
  await expect(dialog.getByLabel('所属项目', { exact: true })).toHaveValue(projectId);
  await expect(dialog.getByLabel('所属业务线', { exact: true })).toHaveValue(line.data.id);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await nav(page, '编辑');
  await expect(page.locator('.actual-pool-choice').first()).toContainText('今日优先节点');
  const auth = await headers(page);
  const preview = await page.request
    .post('/api/business/v1/commands', {
      headers: auth,
      data: { type: 'work.deletePreview', id: todayNode.data.id },
    })
    .then((response) => response.json());
  await page.request.post('/api/business/v1/commands', {
    headers: auth,
    data: {
      type: 'work.delete',
      id: todayNode.data.id,
      expectations: Object.fromEntries(
        preview.result.entries.map((entry: any) => [entry.data.id, entry.revision]),
      ),
    },
  });
  await page.reload();
  await nav(page, '编辑');
  await expect(page.locator('.actual-pool-choice').filter({ hasText: '今日优先节点' })).toHaveCount(
    0,
  );
});

test('已做记录支持长按和网页右键删除', async ({ page }) => {
  for (const [startTime, endTime, description] of [
    ['08:00', '09:00', '手机长按删除'],
    ['09:00', '10:00', '网页右键删除'],
  ])
    await write(page, 'actual', { date: localDay(), startTime, endTime, description });
  await page.reload();
  await nav(page, '今日已做');
  const record = page.locator('[data-actual-id]').filter({ hasText: '手机长按删除' });
  await record.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 200 });
  await expect(page.getByRole('dialog', { name: '实际记录操作' })).toBeVisible();
  await page.getByRole('button', { name: '删除记录', exact: true }).click();
  await expect(record).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page
    .locator('[data-actual-id]')
    .filter({ hasText: '网页右键删除' })
    .click({ button: 'right' });
  await page.getByRole('button', { name: '删除记录', exact: true }).click();
  await expect(page.locator('[data-actual-id]')).toHaveCount(0);
});

test('恢复实际编辑草稿时保留原版本，外部更新后仍拒绝覆盖', async ({ page }) => {
  const original = await write(page, 'actual', {
    date: localDay(),
    startTime: '06:00',
    endTime: '07:00',
    description: '版本保护原文',
  });
  await page.reload();
  await nav(page, '今日已做');
  await page.getByRole('button', { name: '编辑记录 · 版本保护原文', exact: true }).click();
  await page.getByLabel('具体事件', { exact: true }).fill('离开后也保留的修改');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  const response = await page.request.post('/api/business/v1/commands', {
    headers: await headers(page),
    data: {
      type: 'record.save',
      data: { ...original.data, description: '外部新版本' },
      revision: original.revision,
    },
  });
  expect(response.ok()).toBe(true);
  await page.reload();
  await nav(page, '今日已做');
  await page.getByRole('button', { name: '编辑记录 · 外部新版本', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('具体事件', { exact: true })).toHaveValue('离开后也保留的修改');
  await dialog.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('更改');
  expect(
    (await snapshot(page)).entries.find((entry) => entry.data.id === original.data.id)?.data,
  ).toMatchObject({ description: '外部新版本' });
});

test('保存等待中切页再返回保持忙碌状态，保护正在发布的草稿', async ({ page }) => {
  await nav(page, '编辑');
  await page.getByLabel('具体事件', { exact: true }).fill('正在发布的草稿');
  await page.getByLabel('开始时间', { exact: true }).fill('05:00');
  await page.getByLabel('结束时间', { exact: true }).fill('05:30');
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/business/v1/commands', async (route) => {
    if (route.request().postDataJSON().type === 'record.save') await hold;
    await route.continue();
  });
  await page.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await nav(page, '工作空间');
  await nav(page, '编辑');
  await expect(page.getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled();
  await expect(page.getByRole('form', { name: '实际工作录入', exact: true })).toHaveJSProperty(
    'inert',
    true,
  );
  release();
  await expect(page.getByLabel('具体事件', { exact: true })).toHaveValue('');
});

test('随手记保存中切页再返回，发布完成清理草稿且正文只追加一次', async ({ page }) => {
  const data = await snapshot(page);
  const line = data.entries.find((entry) => entry.data.type === 'workline')!;
  await nav(page, '笔记');
  await page.getByRole('button', { name: '打开业务线 论文研究', exact: true }).click();
  await page.getByLabel('随手记', { exact: true }).fill('跨页面等待的唯一随手记');
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/business/v1/commands', async (route) => {
    if (route.request().postDataJSON().type === 'notes.append') await hold;
    await route.continue();
  });
  await page.getByRole('button', { name: '记到笔记', exact: true }).click();
  await nav(page, '工作空间');
  await nav(page, '笔记');
  await page.getByRole('button', { name: '打开业务线 论文研究', exact: true }).click();
  await expect(page.getByRole('button', { name: '记到笔记', exact: true })).toBeDisabled();
  release();
  await expect(page.getByLabel('随手记', { exact: true })).toHaveValue('');
  expect((await notes(page, line.data.id)).split('跨页面等待的唯一随手记')).toHaveLength(2);
});
