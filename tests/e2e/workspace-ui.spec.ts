import { test, expect } from '@playwright/test';
import { connect, seed, nav, write, refresh, snapshot, localDay } from './helpers';

test.beforeEach(async ({ page }) => connect(page));

test('仅超过两天且已完成的节点隐藏，较早未完成节点及过期提醒保留且不改数据', async ({ page }) => {
  const { line } = await seed(page);
  const day = (offset: number) => {
    const date = new Date(localDay() + 'T12:00:00');
    date.setDate(date.getDate() + offset);
    return localDay(date);
  };
  const old = await write(page, 'milestone', {
    title: '三天前未完成',
    lineId: line.data.id,
    dueDate: day(-3),
  });
  await write(page, 'todo', { title: '旧节点的行动', milestoneId: old.data.id });
  await write(page, 'milestone', {
    title: '四天前已完成',
    lineId: line.data.id,
    dueDate: day(-4),
    completedAt: new Date().toISOString(),
  });
  await write(page, 'milestone', { title: '恰好两天前', lineId: line.data.id, dueDate: day(-2) });
  await write(page, 'milestone', { title: '没有截止日期', lineId: line.data.id });
  await refresh(page);
  const before = (await snapshot(page)).entries;
  await page
    .getByRole('status')
    .filter({ hasText: '过期事件 · 2' })
    .getByRole('button', { name: '查看', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.overdue-event-name strong')).toHaveText([
    '三天前未完成',
    '恰好两天前',
  ]);
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await nav(page, '工作空间');
  const board = page.locator('.workspace-content');
  for (const title of ['四天前已完成'])
    await expect(
      board.getByRole('article', { name: `关键节点 · ${title}`, exact: true }),
    ).toHaveCount(0);
  for (const title of ['三天前未完成', '恰好两天前', '没有截止日期', '待办池'])
    await expect(
      board.getByRole('article', { name: `关键节点 · ${title}`, exact: true }),
    ).toBeVisible();
  await page.getByLabel('显示较早已完成节点', { exact: true }).check();
  await expect(
    board.getByRole('article', { name: '关键节点 · 三天前未完成', exact: true }),
  ).toContainText('旧节点的行动');
  await expect(
    board.getByRole('article', { name: '关键节点 · 四天前已完成', exact: true }),
  ).toHaveCount(1);
  expect((await snapshot(page)).entries).toEqual(before);
  await page.reload();
  await nav(page, '工作空间');
  await expect(page.getByLabel('显示较早已完成节点', { exact: true })).not.toBeChecked();
  await expect(
    board.getByRole('article', { name: '关键节点 · 四天前已完成', exact: true }),
  ).toHaveCount(0);
  expect((await snapshot(page)).entries).toEqual(before);
});

test('悬浮颜色直接调整重要性，不触发完成；日期仅保留右键快捷', async ({ page }) => {
  const { line, node, todo, idea } = await seed(page);
  await nav(page, '工作空间');
  const board = page.locator('.workspace-content');
  for (const [entry, selector, level] of [
    [line, '.line-importance', '很急'],
    [node, '.point-dot', '较缓'],
    [todo, '.todo-check', '较急'],
    [idea, '.todo-check', '不急'],
  ] as const) {
    if (!('title' in entry.data)) throw new Error('不是工作条目');
    await board.locator(`[data-space-id="${entry.data.id}"]`).locator(selector).hover();
    const quick = page.getByRole('region', { name: `快捷调整 · ${entry.data.title}`, exact: true });
    await quick.getByRole('button', { name: `重要性：${level}`, exact: true }).click();
    await expect(quick).toHaveCount(0);
  }
  let data = (await snapshot(page)).entries.map((e) => e.data);
  for (const [id, importance] of [
    [line.data.id, 5],
    [node.data.id, 2],
    [todo.data.id, 4],
    [idea.data.id, 1],
  ] as const) {
    expect(data.find((r) => r.id === id)).toMatchObject({ importance, completedAt: null });
  }
  const lineGeometry = await board.locator(`[data-space-id="${line.data.id}"]`).evaluate((el) => {
    const nodes = el.querySelector('.track-nodes')!;
    const origin = el.querySelector('.line-origin')!.getBoundingClientRect();
    const title = el.querySelector('.line-title')!.getBoundingClientRect();
    const dot = el.querySelector('.line-importance .importance-dot')!;
    const dotBox = dot.getBoundingClientRect();
    const first = el.querySelector('.milestone-point .point-dot')!.getBoundingClientRect();
    return {
      color: getComputedStyle(nodes, '::before').borderTopColor,
      dotColor: getComputedStyle(dot).backgroundColor,
      size: dotBox.width,
      alignment: Math.abs(dotBox.top + dotBox.height / 2 - first.top - first.height / 2),
      titleAbove: title.bottom <= dotBox.top,
      gap: el.querySelector('.milestone-point')!.getBoundingClientRect().left - origin.right,
      columns: getComputedStyle(el).gridTemplateColumns,
    };
  });
  expect(lineGeometry.color).toBe(lineGeometry.dotColor);
  expect(lineGeometry.size).toBe(13);
  expect(lineGeometry.alignment).toBeLessThan(1);
  expect(lineGeometry.titleAbove).toBe(true);
  expect(lineGeometry.gap).toBe(40);
  expect(lineGeometry.columns).toBe('none');
  const date = page.getByRole('button', { name: '调整日期 · 方案会议', exact: true });
  await date.hover();
  await page.waitForTimeout(250);
  await expect(page.locator('.quick-editor')).toHaveCount(0);
  await date.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '明日', exact: true }).click();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  await expect(date).toContainText(localDay(tomorrow));
  data = (await snapshot(page)).entries.map((e) => e.data);
  expect(data.find((r) => r.id === node.data.id)).toMatchObject({
    dueDate: localDay(tomorrow),
    dueTime: '09:00',
    completedAt: null,
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Completion remains a direct click, separate from hovering its color.
  await board.getByRole('checkbox', { name: '完成 找人要材料', exact: true }).click();
  await expect(board.getByRole('checkbox', { name: '完成 找人要材料', exact: true })).toBeChecked();
});

test('业务导航独立滚动、折叠和定位，搜索与完成筛选同步，无项目外框', async ({ page }) => {
  const { project, line } = await seed(page);
  if (project.data.type !== 'project' || line.data.type !== 'workline')
    throw new Error('示例归属错误');
  for (let i = 0; i < 12; i++)
    await write(page, 'workline', {
      title: `业务线 ${i}`,
      projectId: project.data.id,
      order: i + 1,
    });
  await write(page, 'workline', {
    title: '已结束线',
    projectId: project.data.id,
    completedAt: new Date().toISOString(),
  });
  await refresh(page);
  await nav(page, '工作空间');
  const explorer = page.getByRole('navigation', { name: '业务导航', exact: true });
  await expect(page.locator('.workspace-page .page-heading')).toHaveCount(0);
  await expect(explorer.getByRole('button', { name: '新增项目', exact: true })).toBeVisible();
  await expect(explorer.getByLabel('显示已完成项目 / 业务线', { exact: true })).toBeVisible();
  const target = page.getByRole('region', { name: '业务线 · 业务线 11', exact: true });
  await explorer.getByRole('button', { name: '定位业务线 · 业务线 11', exact: true }).click();
  await expect(target).toBeInViewport();
  expect(await page.locator('.workspace-content').evaluate((el) => el.scrollTop)).toBeGreaterThan(
    0,
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(
    explorer.getByRole('button', { name: '定位业务线 · 业务线 11', exact: true }),
  ).toHaveAttribute('aria-current', 'location');
  await explorer
    .getByRole('button', { name: `收缩项目 ${project.data.title}`, exact: true })
    .click();
  await expect(
    explorer.getByRole('button', { name: `定位业务线 · ${line.data.title}`, exact: true }),
  ).toHaveCount(0);
  await expect(target).toHaveCount(1);
  await explorer
    .getByRole('button', { name: `展开项目 ${project.data.title}`, exact: true })
    .click();
  await expect(
    explorer.getByRole('button', { name: '定位业务线 · 已结束线', exact: true }),
  ).toHaveCount(0);
  await page.getByLabel('显示已完成项目 / 业务线', { exact: true }).check();
  await expect(
    explorer.getByRole('button', { name: '定位业务线 · 已结束线', exact: true }),
  ).toBeVisible();
  await page.getByLabel('搜索工作', { exact: true }).fill('不存在的工作');
  await expect(explorer.locator('.workspace-nav-tree').getByRole('button')).toHaveCount(0);
  await expect(page.getByText('没有匹配的工作', { exact: true })).toBeVisible();
  await page.getByLabel('搜索工作', { exact: true }).fill('');
  await explorer
    .getByRole('button', { name: `定位项目 · ${project.data.title}`, exact: true })
    .click();
  expect(
    await page.locator('.project-plane').evaluate((el) => ({
      border: getComputedStyle(el).borderTopWidth,
      radius: getComputedStyle(el).borderTopLeftRadius,
    })),
  ).toEqual({ border: '0px', radius: '0px' });
  await page.screenshot({ path: '.test-vault/workspace-explorer-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 600, height: 1000 });
  await explorer.getByRole('button', { name: '定位业务线 · 业务线 11', exact: true }).click();
  await expect(target).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.test-vault/workspace-explorer-mobile.png', fullPage: true });
});

test('下拉框只保留一层圆角表面，原生键盘选择和表单保存可用', async ({ page }) => {
  const { node } = await seed(page);
  await nav(page, '工作空间');
  const point = page.locator(`.workspace-content [data-space-id="${node.data.id}"]`);
  await point.getByRole('button', { name: 'TODO', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const kind = dialog.getByLabel('内容类型', { exact: true });
  await kind.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(kind).toHaveValue('idea');
  await kind.click();
  await page.screenshot({ path: '.test-vault/rounded-select.png', fullPage: true });
  expect(
    await kind.evaluate((el) => ({
      outline: getComputedStyle(el).outlineStyle,
      radius: getComputedStyle(el).borderTopLeftRadius,
      pickerRadius: getComputedStyle(el, '::picker(select)').borderTopLeftRadius,
      appearance: getComputedStyle(el).appearance,
    })),
  ).toEqual({ outline: 'none', radius: '6px', pickerRadius: '8px', appearance: 'base-select' });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  expect(await kind.evaluate((el) => el.matches(':open'))).toBe(false);
  await dialog.getByLabel('标题', { exact: true }).fill('下拉选择新想法');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(point).toContainText('IDEA · 下拉选择新想法');
});
