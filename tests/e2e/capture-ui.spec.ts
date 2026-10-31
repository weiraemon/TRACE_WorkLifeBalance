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

test('普通新增节点可以从微信消息识别时间、业务线、重要性和标签', async ({ page }) => {
  const { line } = await seed(page);
  await nav(page, '工作空间');
  const track = page.getByRole('region', { name: '业务线 · 论文研究', exact: true });
  await track.getByRole('button', { name: '关键节点', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('粘贴微信消息', { exact: true })
    .fill('明天上午九点半论文研究讨论推进方案');
  await dialog.getByRole('button', { name: '识别时间和节点', exact: true }).click();
  await expect(dialog.getByLabel('标题', { exact: true })).toHaveValue('论文研究讨论推进方案');
  await expect(dialog.getByLabel('所属业务线', { exact: true })).toHaveValue(line.data.id);
  await dialog.getByText('可选设置', { exact: true }).click();
  await expect(dialog.getByLabel('截止时刻', { exact: true })).toHaveValue('09:30');
  await expect(dialog.getByLabel('节点标签', { exact: true })).toHaveValue('会议');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = (await snapshot(page)).entries.find(
    (entry) => entry.data.type === 'milestone' && entry.data.title === '论文研究讨论推进方案',
  );
  expect(saved?.data).toMatchObject({
    lineId: line.data.id,
    dueTime: '09:30',
    tags: ['会议'],
  });
});

test('今日优先显示定时节点，悬浮看全部条目，记一段保留草稿；移动端可点击预览', async ({ page }) => {
  const { line, node, todo } = await seed(page);
  await write(page, 'milestone', {
    title: '早间实验',
    lineId: line.data.id,
    dueDate: localDay(),
    dueTime: '08:00',
  });
  await write(page, 'milestone', {
    title: '未定时节点',
    lineId: line.data.id,
    dueDate: localDay(),
  });
  const otherProject = await write(page, 'project', { title: '另一个项目', order: -10 });
  const otherLine = await write(page, 'workline', {
    title: '跨线安排',
    projectId: otherProject.data.id,
  });
  await write(page, 'milestone', {
    title: '跨线晨会',
    lineId: otherLine.data.id,
    dueDate: localDay(),
    dueTime: '07:30',
  });
  const tomorrow = new Date(localDay() + 'T12:00:00');
  tomorrow.setDate(tomorrow.getDate() + 1);
  await write(page, 'todo', {
    title: '明日完成的所属条目',
    kind: 'idea',
    milestoneId: node.data.id,
    dueDate: localDay(tomorrow),
  });
  await write(page, 'todo', {
    title: '已完成的所属想法',
    kind: 'idea',
    milestoneId: node.data.id,
    completedAt: new Date().toISOString(),
  });
  await write(page, 'todo', {
    title: '确认材料进度',
    milestoneId: node.data.id,
    direction: 'from',
    person: '小王',
  });
  await refresh(page);
  const agenda = page.getByRole('navigation', { name: '今日导航', exact: true });
  const list = agenda.getByRole('region', { name: '当天待办', exact: true });
  await expect(list.locator('.today-node .today-task > span')).toHaveText([
    '跨线晨会',
    '早间实验',
    '方案会议',
    '未定时节点',
  ]);
  await expect(list.locator('.today-node time')).toHaveText(['07:30', '08:00', '09:00']);
  await expect(list.locator('.today-task')).not.toContainText(['明日完成的所属条目']);
  const colors = await list
    .locator('.today-node')
    .first()
    .evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      color: getComputedStyle(el.querySelector('.today-row')!).color,
    }));
  expect(colors.color).toBe('rgb(255, 255, 255)');
  expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
  const nodeButton = list.locator(`[data-space-id="${node.data.id}"] .today-row`);
  await nodeButton.hover();
  const preview = page.getByRole('region', { name: '方案会议的全部待办', exact: true });
  await expect(preview).toContainText('明日完成的所属条目');
  await expect(preview).toContainText('已完成的所属想法');
  await preview.hover();
  await expect(preview).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).not.toBeVisible();
  await nodeButton.focus();
  await expect(preview).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: '今天联系谁', exact: true })).toContainText(
    '等 小王',
  );
  const form = page.getByRole('form', { name: '实际工作录入', exact: true });
  await expect(form.getByRole('region', { name: '待选池', exact: true })).not.toBeVisible();
  await form.getByLabel('具体事件', { exact: true }).fill('直接推进会议节点');
  await form.getByLabel('开始时间', { exact: true }).fill('10:00');
  await form.getByLabel('结束时间', { exact: true }).fill('11:00');
  await list.getByRole('button', { name: '记一段 · 方案会议', exact: true }).click();
  await list.getByRole('button', { name: '记一段 · 找人要材料', exact: true }).click();
  await expect(form.getByLabel('具体事件', { exact: true })).toHaveValue('直接推进会议节点');
  await expect(
    form.getByRole('checkbox', { name: '本次完成 找人要材料', exact: true }),
  ).not.toBeChecked();
  await form.getByText('成果 / 下一步 · 方案会议', { exact: true }).click();
  await form.getByLabel('批注 · 方案会议', { exact: true }).fill('会议确定了下一步方案');
  await form.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(form.getByLabel('具体事件', { exact: true })).toHaveValue('');
  await expect(form.getByRole('region', { name: '已选择', exact: true })).toHaveCount(0);
  const state = await snapshot(page);
  expect(state.entries.find((e) => e.data.type === 'actual')?.data).toMatchObject({
    milestoneIds: [node.data.id],
    itemIds: [todo.data.id],
    startTime: '10:00',
    endTime: '11:00',
  });
  expect(state.entries.find((e) => e.data.id === todo.data.id)?.data).toHaveProperty(
    'completedAt',
    null,
  );
  expect(await notes(page, line.data.id)).toContain('会议确定了下一步方案');
  expect(await notes(page, line.data.id)).not.toContain('直接推进会议节点');
  await expect(page.getByRole('region', { name: '当天实际记录', exact: true })).toContainText(
    '直接推进会议节点',
  );
  await page.getByRole('button', { name: '编辑记录 · 直接推进会议节点', exact: true }).click();
  const edit = page.getByRole('dialog');
  await expect(edit.getByLabel('具体事件', { exact: true })).toHaveValue('直接推进会议节点');
  await edit.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('tab', { name: '待办 / 节点', exact: true }).click();
  const capture = page.getByRole('region', { name: '快速创建 TODO / IDEA', exact: true });
  await expect(
    agenda.getByRole('region', { name: '快速创建 TODO / IDEA', exact: true }),
  ).toHaveCount(0);
  await capture.getByLabel('业务线', { exact: true }).selectOption(line.data.id);
  await capture.getByLabel('要做什么', { exact: true }).fill('当天快速待办');
  await capture.getByRole('button', { name: '添加', exact: true }).click();
  await expect(list).toContainText('当天快速待办');
  await expect(page.getByRole('region', { name: '计划与实际', exact: true })).toHaveCount(0);
  await page.screenshot({
    path: '.test-vault/today-navigation-capture-desktop.png',
    fullPage: true,
  });
  for (const width of [600, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await nodeButton.click();
    await expect(preview).toBeVisible();
    const rect = await preview.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    await preview.getByRole('button', { name: '关闭预览', exact: true }).click();
    await page.screenshot({ path: `.test-vault/today-capture-${width}.png`, fullPage: true });
  }
  await nav(page, '工作空间');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(form.getByLabel('具体事件', { exact: true })).toBeFocused();
});

test('今日统一排序，完成的定时节点立即置底，保留原重要性；联络默认展开', async ({ page }) => {
  const { line, node } = await seed(page);
  await write(page, 'milestone', {
    title: '同刻更急',
    lineId: line.data.id,
    dueDate: localDay(),
    dueTime: '09:00',
    importance: 5,
  });
  await write(page, 'milestone', {
    title: '无时刻节点',
    lineId: line.data.id,
    dueDate: localDay(),
    importance: 3,
  });
  await write(page, 'milestone', {
    title: '七点已完成',
    lineId: line.data.id,
    dueDate: localDay(),
    dueTime: '07:00',
    importance: 5,
    completedAt: new Date().toISOString(),
  });
  const pool = (await snapshot(page)).entries.find(
    (e) => e.data.type === 'milestone' && e.data.lineId === line.data.id && e.data.pool,
  )!;
  await write(page, 'todo', {
    title: '无时刻最急',
    milestoneId: pool.data.id,
    dueDate: localDay(),
    importance: 5,
  });
  await write(page, 'todo', {
    title: '需要找小王',
    milestoneId: node.data.id,
    direction: 'to',
    person: '小王',
  });
  await refresh(page);
  const agenda = page.getByRole('navigation', { name: '今日导航', exact: true });
  const rows = agenda.locator('.today-todos > li .today-task > span');
  const titles = await rows.allTextContents();
  expect(titles.slice(0, 4).map((t) => t.trim())).toEqual([
    '同刻更急',
    '方案会议',
    '无时刻最急',
    '无时刻节点',
  ]);
  expect(titles.at(-1)?.trim()).toBe('七点已完成');
  await expect(page.getByRole('region', { name: '今天联系谁', exact: true })).toContainText(
    '找 小王',
  );
  await page.getByRole('checkbox', { name: '完成节点 同刻更急', exact: true }).click();
  await expect
    .poll(async () => (await rows.allTextContents()).slice(-2).map((text) => text.trim()))
    .toEqual(['同刻更急', '七点已完成']);
  const saved = (await snapshot(page)).entries.find(
    (e) => e.data.type === 'milestone' && e.data.title === '同刻更急',
  )!.data;
  expect(saved).toMatchObject({ importance: 5, completedAt: expect.any(String) });
});

test('待办节点设置直接展开，顶部粘贴消息自动匹配后可修改并保存', async ({ page }) => {
  const { line } = await seed(page);
  await page.getByRole('tab', { name: '待办 / 节点', exact: true }).click();
  const capture = page.getByRole('region', { name: '快速创建 TODO / IDEA', exact: true });
  await expect(capture.locator('details')).toHaveCount(0);
  await expect(capture.getByText('粘贴微信消息', { exact: true })).toHaveCount(0);
  await expect(
    capture.getByText('粘贴消息后自动识别日期、时刻、业务线、重要性和标签，结果可在下方修改。', {
      exact: true,
    }),
  ).toHaveCount(0);
  for (const label of [
    '粘贴微信消息',
    '业务线',
    '类型',
    '要做什么',
    '具体节点',
    '条目日期',
    '批注',
  ])
    await expect(capture.getByLabel(label, { exact: true })).toBeVisible();
  await expect(capture.getByRole('button', { name: '重要性：不急', exact: true })).toBeVisible();
  const source = capture.getByLabel('粘贴微信消息', { exact: true });
  const order = await capture.evaluate((el) => ({
    paste: el.querySelector('.quick-capture-paste')!.getBoundingClientRect().top,
    line: el.querySelector('.quick-capture-controls')!.getBoundingClientRect().top,
  }));
  expect(order.paste).toBeLessThan(order.line);
  await source.evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text', '明天上午九点半论文研究讨论推进方案');
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  const tomorrow = new Date(localDay() + 'T12:00:00');
  tomorrow.setDate(tomorrow.getDate() + 1);
  await expect(capture.getByLabel('业务线', { exact: true })).toHaveValue(line.data.id);
  await expect(capture.getByLabel('类型', { exact: true })).toHaveValue('milestone');
  await expect(capture.getByLabel('要做什么', { exact: true })).toHaveValue('论文研究讨论推进方案');
  await expect(capture.getByLabel('截止日期', { exact: true })).toHaveValue(localDay(tomorrow));
  await expect(capture.getByLabel('截止时刻', { exact: true })).toHaveValue('09:30');
  await expect(capture.getByLabel('节点标签', { exact: true })).toHaveValue('会议');
  await expect(capture.getByRole('button', { name: '重要性：一般', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(capture.getByLabel('条目日期', { exact: true })).toHaveCount(0);
  await capture.getByLabel('要做什么', { exact: true }).fill('校正后的方案讨论');
  await capture.getByLabel('截止时刻', { exact: true }).fill('10:00');
  await capture.getByLabel('节点标签', { exact: true }).fill('讨论，报告');
  await capture.getByLabel('批注', { exact: true }).fill('会前准备材料');
  await capture.getByRole('button', { name: '添加', exact: true }).click();
  await expect(capture.getByLabel('要做什么', { exact: true })).toHaveValue('');
  const state = await snapshot(page);
  expect(
    state.entries.find((e) => e.data.type === 'milestone' && e.data.title === '校正后的方案讨论')
      ?.data,
  ).toMatchObject({
    lineId: line.data.id,
    dueDate: localDay(tomorrow),
    dueTime: '10:00',
    tags: ['讨论', '报告'],
    importance: 3,
  });
  expect(await notes(page, line.data.id)).toContain('会前准备材料');
  expect(state.entries.filter((e) => e.data.type === 'actual')).toHaveLength(0);
  expect(
    await page
      .locator('.sliding-tabs-panel')
      .last()
      .evaluate((el) => el.scrollTop),
  ).toBe(0);
  await expect(
    capture.getByRole('heading', { name: '自动匹配与识别', exact: true }),
  ).toBeInViewport();
  await capture.getByLabel('类型', { exact: true }).selectOption('todo');
  await expect(capture.getByLabel('具体节点', { exact: true })).toBeVisible();
  await expect(capture.getByLabel('条目日期', { exact: true })).toBeVisible();
  await expect(capture.locator('details')).toHaveCount(0);
  await page.screenshot({ path: '.test-vault/today-recognition-first.png', fullPage: true });
});
