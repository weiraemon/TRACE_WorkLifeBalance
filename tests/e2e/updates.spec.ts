import { test, expect } from '@playwright/test';
import { connect, write, refresh, nav, seed, localDay } from './helpers';
test.beforeEach(async ({ page }) => connect(page));

test('三份手动快照，删除不自动备份，不提供逐操作撤销', async ({ page }) => {
  await write(page, 'project', { title: '测试项目' });
  await refresh(page);
  await page.getByRole('button', { name: 'Vault 与备份', exact: true }).click();
  const dialog = page.getByRole('dialog');
  for (let i = 0; i < 4; i++) {
    await dialog.getByRole('button', { name: '创建管理数据快照', exact: true }).click();
    await expect(dialog.locator('.backup-row')).toHaveCount(Math.min(i + 1, 3));
    await expect(
      dialog.getByRole('button', { name: '创建管理数据快照', exact: true }),
    ).toBeEnabled();
  }
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await nav(page, '工作空间');
  await page
    .getByRole('button', { name: '收缩项目 测试项目', exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除项目', exact: true }).click();
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('region', { name: '项目面 · 测试项目', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '撤销删除', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Vault 与备份', exact: true }).click();
  await expect(dialog.locator('.backup-row')).toHaveCount(3);
  page.once('dialog', (value) => value.accept());
  await dialog.getByRole('button', { name: '恢复', exact: true }).first().click();
  await expect(dialog.getByRole('status')).toContainText('已恢复 1');
});

test('右键编辑和删除可用键盘操作，节点和条目新增批注、完成、升线操作', async ({ page }) => {
  const { node, todo } = await seed(page);
  await nav(page, '工作空间');
  for (const [entry, selector, label, heading] of [
    [node, '.point-title', '节点', '节点'],
    [todo, '.todo-title', '条目', 'TODO'],
  ] as const) {
    const target = page.locator(`[data-space-id="${entry.data.id}"]`).first().locator(selector);
    await target.click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: '添加批注', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '升级为业务线', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: `编辑${label}`, exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: `删除${label}`, exact: true })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: `编辑${heading}`, exact: true }),
    ).toBeVisible();
    await dialog.getByLabel('标题', { exact: true }).fill(label + '改名');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(target).toContainText(label + '改名');
  }
});

test('条目独立日期可提前安排，今日完成后保留划线，不改变节点截止点', async ({ page }) => {
  const { todo } = await seed(page);
  await nav(page, '工作空间');
  await page
    .locator(`[data-space-id="${todo.data.id}"]`)
    .first()
    .locator('.todo-title')
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑条目', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('可选设置', { exact: true }).click();
  await expect(dialog.locator('input[type="time"]')).toHaveCount(0);
  await dialog.getByLabel('条目日期', { exact: true }).fill(localDay());
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await nav(page, '今日');
  await page.getByRole('checkbox', { name: '完成 找人要材料', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '完成 找人要材料', exact: true })).toBeChecked();
  await expect(page.locator('.today-row-done')).toContainText('找人要材料');
});

test('节点按截止点排序，池固定末端，改期立即重排，桌面与窄屏一致', async ({ page }) => {
  const project = await write(page, 'project', { title: '项目' });
  const line = await write(page, 'workline', { title: '排序线', projectId: project.data.id });
  await write(page, 'workline', { title: '空线', projectId: project.data.id });
  await write(page, 'milestone', {
    title: '下午',
    lineId: line.data.id,
    dueDate: '2026-10-25',
    dueTime: '18:00',
  });
  await write(page, 'milestone', {
    title: '最早未定',
    lineId: line.data.id,
    createdAt: '2020-01-01T00:00:00Z',
  });
  await write(page, 'milestone', {
    title: '上午',
    lineId: line.data.id,
    dueDate: '2026-10-25',
    dueTime: '09:00',
  });
  const changed = await write(page, 'milestone', {
    title: '后来未定',
    lineId: line.data.id,
    createdAt: '2020-01-02T00:00:00Z',
  });
  await refresh(page);
  await nav(page, '工作空间');
  const track = page.getByRole('region', { name: '业务线 · 排序线', exact: true }),
    titles = track.locator('.point-title');
  const emptyTrack = page.getByRole('region', { name: '业务线 · 空线', exact: true });
  const checkPool = async (target: typeof track) => {
    await expect(target.locator('.todo-pool .point-dot')).toHaveCount(0);
    const layout = await target.evaluate((el) => {
      const nodes = el.querySelector('.track-nodes')!;
      const poolTitle = el.querySelector('.todo-pool .point-title')!.getBoundingClientRect();
      const nodeTitle = nodes.querySelector('.point-title')?.getBoundingClientRect();
      const nodesBox = nodes.getBoundingClientRect();
      const lineRight = nodesBox.right - parseFloat(getComputedStyle(nodes, '::before').right);
      return {
        gap: poolTitle.left - lineRight,
        aligned: nodeTitle ? poolTitle.top - nodeTitle.top : 0,
      };
    });
    expect(layout.gap).toBeGreaterThan(0);
    expect(layout.aligned).toBe(0);
  };
  await checkPool(track);
  await checkPool(emptyTrack);
  await expect(titles).toHaveText(['上午', '下午', '后来未定', '最早未定', '待办池']);
  await track.getByRole('button', { name: '后来未定', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑节点', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('可选设置', { exact: true }).click();
  await dialog.getByLabel('截止日期', { exact: true }).fill('2026-10-24');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(titles).toHaveText(['后来未定', '上午', '下午', '最早未定', '待办池']);
  await track.locator('.track-scroll').evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await page.screenshot({ path: '.test-vault/line-workspace-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 600, height: 1000 });
  await expect(titles).toHaveText(['后来未定', '上午', '下午', '最早未定', '待办池']);
  await checkPool(track);
  await checkPool(emptyTrack);
  expect(
    await track.locator('.track-scroll').evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
