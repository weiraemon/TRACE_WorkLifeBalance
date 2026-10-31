import { test, expect } from '@playwright/test';
import { connect, seed, write, refresh, snapshot, nav, headers, notes, localDay } from './helpers';

test.beforeEach(async ({ page }) => connect(page));

test('回顾和今日均可修改实际记录，改日期时间正文保留 ID、关联、完成事实与 Notes', async ({
  page,
}) => {
  const { line, node, todo } = await seed(page);
  const previous = new Date(localDay() + 'T12:00:00');
  previous.setDate(previous.getDate() - 1);
  const actual = await write(page, 'actual', {
    date: localDay(previous),
    startTime: '14:30',
    endTime: '15:02',
    description: '写错日期的讨论',
    milestoneIds: [node.data.id],
    itemIds: [todo.data.id],
  });
  const originalNotes = await notes(page, line.data.id);
  await refresh(page);
  await nav(page, '回顾');
  await page.getByLabel('回顾日期', { exact: true }).fill(localDay(previous));
  await page.getByRole('button', { name: '编辑记录 · 写错日期的讨论', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('记录日期', { exact: true })).toHaveValue(localDay(previous));
  await dialog.getByLabel('记录日期', { exact: true }).fill(localDay());
  await dialog.getByLabel('开始时间', { exact: true }).fill('15:00');
  await dialog.getByLabel('结束时间', { exact: true }).fill('16:00');
  await dialog.getByLabel('具体事件', { exact: true }).fill('修正后的讨论记录');
  await dialog.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let state = await snapshot(page);
  expect(state.entries.filter((e) => e.data.type === 'actual')).toHaveLength(1);
  expect(state.entries.find((e) => e.data.id === actual.data.id)?.data).toMatchObject({
    date: localDay(),
    startTime: '15:00',
    endTime: '16:00',
    description: '修正后的讨论记录',
    milestoneIds: [node.data.id],
    itemIds: [todo.data.id],
  });
  expect(state.entries.find((e) => e.data.id === todo.data.id)?.data).toHaveProperty(
    'completedAt',
    null,
  );
  expect(await notes(page, line.data.id)).toBe(originalNotes);
  await nav(page, '今日');
  const form = page.getByRole('form', { name: '实际工作录入', exact: true });
  await form.getByLabel('具体事件', { exact: true }).fill('下一段尚未保存的工作');
  const feed = page.getByRole('region', { name: '当天实际记录', exact: true });
  await feed.getByRole('button', { name: '编辑记录 · 修正后的讨论记录', exact: true }).click();
  await dialog.getByLabel('具体事件', { exact: true }).fill('再次修正正文');
  await dialog.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(form.getByLabel('具体事件', { exact: true })).toHaveValue('下一段尚未保存的工作');
  await expect(feed).toContainText('再次修正正文');
  state = await snapshot(page);
  expect(state.entries.filter((e) => e.data.type === 'actual')).toHaveLength(1);
});

test('实际记录修改保留冲突草稿，不覆盖外部修改，也拒绝重叠时段', async ({ page }) => {
  await seed(page);
  const original = await write(page, 'actual', {
    date: localDay(),
    startTime: '09:00',
    endTime: '10:00',
    description: '原始记录',
  });
  await write(page, 'actual', {
    date: localDay(),
    startTime: '11:00',
    endTime: '12:00',
    description: '已有工作',
  });
  await refresh(page);
  await nav(page, '回顾');
  await page.getByRole('button', { name: '编辑记录 · 原始记录', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('开始时间', { exact: true }).fill('11:30');
  await dialog.getByLabel('结束时间', { exact: true }).fill('12:30');
  await dialog.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('重叠');
  await dialog.getByLabel('开始时间', { exact: true }).fill('09:00');
  await dialog.getByLabel('结束时间', { exact: true }).fill('10:00');
  await dialog.getByLabel('具体事件', { exact: true }).fill('网页里的未保存修改');
  const response = await page.request.post('/api/records', {
    headers: await headers(page),
    data: {
      data: { ...original.data, description: '外部已保存修改' },
      revision: original.revision,
    },
  });
  expect(response.ok()).toBe(true);
  await dialog.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('更改');
  await expect(dialog.getByLabel('具体事件', { exact: true })).toHaveValue('网页里的未保存修改');
  expect(
    (await snapshot(page)).entries.find((e) => e.data.id === original.data.id)?.data,
  ).toHaveProperty('description', '外部已保存修改');
});

test('三栏与紧凑清单尺寸固定，展开设置、浮层和抽屉不挤压内容', async ({ page }) => {
  const { node, line } = await seed(page);
  await write(page, 'todo', {
    title: '确认材料进度',
    milestoneId: node.data.id,
    direction: 'from',
    person: '小王',
  });
  await write(page, 'actual', {
    date: localDay(),
    startTime: '10:00',
    endTime: '11:00',
    description: '布局检查记录',
  });
  await refresh(page);
  const layout = page.locator('.today-layout');
  const sizes = () =>
    layout.evaluate((el) =>
      [...el.children].map((child) => {
        const r = child.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
  const original = await sizes();
  expect(original).toHaveLength(3);
  expect(original[0].x).toBeLessThan(original[1].x);
  expect(original[1].x).toBeLessThan(original[2].x);
  await expect(page.getByRole('complementary', { name: '联络侧栏', exact: true })).toContainText(
    '等 小王',
  );
  expect(
    await page
      .locator('.today-item-row')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height),
  ).toBe(48);
  const form = page.getByRole('form', { name: '实际工作录入', exact: true });
  await form.getByText('关联节点或待办（可选）', { exact: true }).click();
  await expect.poll(sizes).toEqual(original);
  await form.getByText('关联节点或待办（可选）', { exact: true }).click();
  await page.getByRole('button', { name: '记一段 · 方案会议', exact: true }).click();
  await form.getByText('成果 / 下一步 · 方案会议', { exact: true }).click();
  await form.getByLabel('批注 · 方案会议', { exact: true }).fill('长内容'.repeat(100));
  await expect.poll(sizes).toEqual(original);
  await page.getByRole('button', { name: '编辑记录 · 布局检查记录', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const before = await dialog.boundingBox();
  await dialog.getByText('关联节点或待办（可选）', { exact: true }).click();
  await expect.poll(() => dialog.boundingBox()).toEqual(before);
  await dialog.getByLabel('具体事件', { exact: true }).fill('很长的编辑内容'.repeat(200));
  await expect.poll(() => dialog.boundingBox()).toEqual(before);
  await expect.poll(sizes).toEqual(original);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.screenshot({ path: '.test-vault/today-fixed-columns-desktop.png', fullPage: true });
  await nav(page, '工作空间');
  const workspace = page.locator('.workspace-content');
  const width = await workspace.evaluate((el) => el.getBoundingClientRect().width);
  await page
    .getByRole('region', { name: '业务线 · 论文研究', exact: true })
    .locator('.line-title')
    .click();
  await expect(page.getByRole('complementary', { name: '工作详情', exact: true })).toBeVisible();
  expect(await workspace.evaluate((el) => el.getBoundingClientRect().width)).toBe(width);
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await nav(page, '今日');
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.test-vault/today-fixed-columns-mobile.png', fullPage: true });
});

test('已记录移入联络侧栏独立滚动，右侧滑动切换保留两份草稿并支持键盘', async ({ page }) => {
  await seed(page);
  for (let i = 0; i < 12; i++) {
    const hour = String(6 + Math.floor(i / 2)).padStart(2, '0');
    const nextHour = String(6 + Math.floor((i + 1) / 2)).padStart(2, '0');
    await write(page, 'actual', {
      date: localDay(),
      startTime: `${hour}:${i % 2 ? '30' : '00'}`,
      endTime: `${nextHour}:${i % 2 ? '00' : '30'}`,
      description: `工作片段 ${i + 1}`,
    });
  }
  await refresh(page);
  const sidebar = page.getByRole('complementary', { name: '联络侧栏', exact: true });
  const feed = sidebar.getByRole('region', { name: '当天实际记录', exact: true });
  const list = feed.locator('.actual-record-list');
  await expect(
    page
      .getByRole('region', { name: '做了什么', exact: true })
      .getByRole('region', { name: '当天实际记录', exact: true }),
  ).toHaveCount(0);
  const actualTab = page.getByRole('tab', { name: '今日已做', exact: true });
  const quickTab = page.getByRole('tab', { name: '待办 / 节点', exact: true });
  const input = page
    .getByRole('form', { name: '实际工作录入', exact: true })
    .getByLabel('具体事件', { exact: true });
  await input.fill('继续输入中的工作');
  await quickTab.click();
  await expect(quickTab).toHaveAttribute('aria-selected', 'true');
  await expect(actualTab).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('form', { name: '实际工作录入', exact: true })).toHaveCount(0);
  const quick = page.getByRole('region', { name: '快速创建 TODO / IDEA', exact: true });
  await quick.getByLabel('要做什么', { exact: true }).fill('还未添加的下一步');
  expect(
    await page
      .locator('.sliding-tabs-panel')
      .first()
      .evaluate((el) => getComputedStyle(el).transitionProperty),
  ).toBe('transform');
  await actualTab.click();
  await expect(input).toHaveValue('继续输入中的工作');
  await actualTab.press('ArrowRight');
  await expect(quickTab).toBeFocused();
  await expect(quick.getByLabel('要做什么', { exact: true })).toHaveValue('还未添加的下一步');
  await page.getByRole('button', { name: '记一段 · 方案会议', exact: true }).click();
  await expect(actualTab).toHaveAttribute('aria-selected', 'true');
  await expect(input).toHaveValue('继续输入中的工作');
  await expect
    .poll(() =>
      page
        .locator('.sliding-tabs-panel')
        .first()
        .evaluate((el) =>
          Math.round(
            el.getBoundingClientRect().left - el.parentElement!.getBoundingClientRect().left,
          ),
        ),
    )
    .toBe(0);
  expect(await page.locator('.sliding-tabs-viewport').evaluate((el) => el.scrollLeft)).toBe(0);
  const capture = page.locator('.today-capture');
  const fixed = () => capture.boundingBox();
  const before = await fixed();
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await list.hover();
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(feed.getByText('工作片段 1', { exact: true })).toBeInViewport();
  await expect(input).toBeInViewport();
  await expect.poll(fixed).toEqual(before);
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  await page.screenshot({ path: '.test-vault/today-capture-tabs.png', fullPage: true });
  await quickTab.click();
  await actualTab.click();
  await expect(input).toHaveValue('继续输入中的工作');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page
      .locator('.sliding-tabs-panel')
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe('0s');
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
