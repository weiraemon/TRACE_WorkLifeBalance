import { test, expect } from '@playwright/test';
import { connect, seed, nav, write, refresh, snapshot, notes, localDay } from './helpers';

test.beforeEach(async ({ page }) => connect(page));

test('新增主区域直接选择重要性，默认绿色；无标签圆点，有标签使用对应图标且标签与时间在上方', async ({
  page,
}) => {
  const { line } = await seed(page);
  await nav(page, '工作空间');
  const track = page.getByRole('region', { name: '业务线 · 论文研究', exact: true });
  await track.getByRole('button', { name: '关键节点', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '重要性：不急', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '重要性：不急', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog.getByLabel('节点标签', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('节点标签', { exact: true })).toHaveValue('');
  await dialog.getByLabel('标题', { exact: true }).fill('无标签节点');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = (await snapshot(page)).entries.find(
    (e) => e.data.type === 'milestone' && e.data.title === '无标签节点',
  )!;
  expect(saved.data).toMatchObject({ importance: 1, tags: [] });
  const plain = track.locator(`[data-space-id="${saved.data.id}"] .point-dot`);
  await expect(plain).not.toHaveClass(/node-tagged/);
  await expect(plain.locator('svg')).toHaveCount(0);
  const icons: string[] = [];
  for (const tag of ['会议', '专注', '报告']) {
    const point = await write(page, 'milestone', {
      title: tag + '节点',
      lineId: line.data.id,
      tags: [tag],
      dueDate: localDay(),
      dueTime: '15:00',
    });
    await refresh(page);
    const marker = track.locator(`[data-space-id="${point.data.id}"]`);
    await expect(marker.locator('.point-dot.node-tagged svg')).toHaveCount(1);
    icons.push(await marker.locator('.point-dot svg').innerHTML());
    const layout = await marker.evaluate((el) => ({
      tag: el.querySelector('.node-tags')!.getBoundingClientRect().bottom,
      time: el.querySelector('.point-dates')!.getBoundingClientRect().bottom,
      dot: el.querySelector('.point-dot')!.getBoundingClientRect().top,
    }));
    expect(layout.tag).toBeLessThan(layout.dot);
    expect(layout.time).toBeLessThan(layout.dot);
  }
  expect(new Set(icons).size).toBe(3);
  await page.screenshot({ path: '.test-vault/node-tag-icons.png', fullPage: true });
});

test('今日左侧导航放待办与联系人，右侧直接录入实际并关联节点；快速想法仍不需要时间', async ({
  page,
}) => {
  const { line, node, project } = await seed(page);
  await write(page, 'todo', {
    title: '确认材料进度',
    milestoneId: node.data.id,
    direction: 'from',
    person: '小王',
  });
  await refresh(page);
  const agenda = page.getByRole('navigation', { name: '今日导航', exact: true });
  await expect(agenda.getByRole('region', { name: '当天待办', exact: true })).toBeVisible();
  await expect(agenda.getByRole('region', { name: '今天联系谁', exact: true })).toContainText(
    '等 小王',
  );
  const form = page.getByRole('form', { name: '实际工作录入', exact: true });
  for (const name of ['具体事件', '开始时间', '结束时间', '先选择业务线', '关联节点'])
    await expect(form.getByLabel(name, { exact: true })).toBeVisible();
  const layout = await page.locator('.today-layout').evaluate((el) => {
    const timeline = el.querySelector('.timeline-scroll')!.getBoundingClientRect();
    const controls = [...el.querySelectorAll('.actual-time-fields input, .form-grid select')].map(
      (control) => ({
        height: control.getBoundingClientRect().height,
        background: getComputedStyle(control).backgroundColor,
        border: getComputedStyle(control).borderLeftWidth,
      }),
    );
    return {
      bottom: el.getBoundingClientRect().bottom,
      timelineBottom: timeline.bottom,
      height: timeline.height,
      controls,
    };
  });
  expect(layout.bottom).toBeGreaterThan(950);
  expect(Math.abs(layout.timelineBottom - layout.bottom)).toBeLessThan(2);
  expect(layout.height).toBeGreaterThan(750);
  expect(layout.controls).toHaveLength(5);
  for (const control of layout.controls)
    expect(control).toEqual({ height: 40, background: 'rgba(0, 0, 0, 0)', border: '0px' });
  await expect(form.locator('details')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '记录实际', exact: true })).toHaveCount(0);
  await form.getByLabel('具体事件', { exact: true }).fill('直接推进会议节点');
  await form.getByLabel('开始时间', { exact: true }).fill('10:00');
  await form.getByLabel('结束时间', { exact: true }).fill('11:00');
  await form.getByLabel('先选择业务线', { exact: true }).selectOption(line.data.id);
  await form.getByLabel('关联节点', { exact: true }).selectOption(node.data.id);
  await expect(
    form.getByRole('checkbox', { name: '关联节点 方案会议', exact: true }),
  ).toBeChecked();
  await form.getByLabel('批注 · 方案会议', { exact: true }).fill('会议确定了下一步方案');
  await form.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(form.getByLabel('具体事件', { exact: true })).toHaveValue('');
  let state = await snapshot(page);
  expect(state.entries.find((e) => e.data.type === 'actual')?.data).toMatchObject({
    milestoneIds: [node.data.id],
    itemIds: [],
    startTime: '10:00',
    endTime: '11:00',
  });
  expect(state.entries.find((e) => e.data.id === node.data.id)?.data).toHaveProperty(
    'completedAt',
    null,
  );
  expect(await notes(page, line.data.id)).toContain('会议确定了下一步方案');
  expect(await notes(page, line.data.id)).not.toContain('直接推进会议节点');
  await page.getByRole('button', { name: 'TODO / IDEA', exact: true }).click();
  const capture = page.getByRole('region', { name: '快速创建 TODO / IDEA', exact: true });
  await expect(capture.getByRole('button', { name: '重要性：不急', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await capture.getByLabel('要做什么', { exact: true }).fill('无时间的新想法');
  await capture.getByLabel('业务线', { exact: true }).selectOption(line.data.id);
  await capture.getByRole('button', { name: '添加', exact: true }).click();
  await expect(capture.getByLabel('要做什么', { exact: true })).toHaveValue('');
  state = await snapshot(page);
  expect(state.entries.filter((e) => e.data.type === 'actual')).toHaveLength(1);
  expect(
    state.entries.find((e) => e.data.type === 'todo' && e.data.title === '无时间的新想法')?.data,
  ).toHaveProperty('importance', 1);
  await page.getByRole('button', { name: '实际工作', exact: true }).click();
  await page.locator('.today-lists').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: '.test-vault/today-navigation-capture-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 600, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(agenda).toBeVisible();
  await page.screenshot({
    path: '.test-vault/today-navigation-capture-mobile.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.test-vault/today-capture-375.png', fullPage: true });
  await nav(page, '工作空间');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('navigation', { name: '今日导航', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(form.getByLabel('具体事件', { exact: true })).toBeFocused();
});
