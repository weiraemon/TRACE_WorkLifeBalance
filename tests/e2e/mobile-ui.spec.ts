import { expect, test } from '@playwright/test';
import { connect, seed, write, snapshot, notes, localDay } from './helpers';

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

test('六个入口、圆圈导览和竖向业务线共享数据，滑动切线有等价按钮', async ({ page }) => {
  const data = await snapshot(page);
  const project = data.entries.find((entry) => entry.data.type === 'project')!;
  for (let index = 0; index < 5; index++)
    await write(page, 'workline', { title: `探索业务线 ${index + 1}`, projectId: project.data.id });
  await page.reload();
  await nav(page, '工作空间');
  await expect(page.locator('.mobile-navigation button')).toHaveCount(6);
  await expect(page.locator('.mobile-orbit')).toHaveCount(2);
  await page.getByRole('button', { name: '打开业务线 论文研究', exact: true }).click();
  await expect(page.getByRole('heading', { name: '论文研究', exact: true })).toBeVisible();
  await expect(page.locator('.mobile-node').last()).toContainText('待办池');
  await page.getByRole('button', { name: '下一条业务线' }).click();
  await expect(page.getByRole('heading', { name: '探索业务线 1' })).toBeVisible();
  await page.getByRole('button', { name: '上一条业务线' }).click();
  await page.getByRole('checkbox', { name: '完成 找人要材料', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '完成 找人要材料', exact: true })).toBeChecked();
  await page.getByRole('button', { name: '条目操作 · 找人要材料', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: '重新打开', exact: true }),
  ).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '重新打开', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: '完成 找人要材料', exact: true }),
  ).not.toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-workspace.png' });
});

test('实际录入和已做分开，保存关联与本次完成仍联合发布', async ({ page }) => {
  await nav(page, '编辑');
  await page.getByLabel('具体事件', { exact: true }).fill('在手机上完成材料整理');
  await page.getByLabel('开始时间', { exact: true }).fill('09:00');
  await page.getByLabel('结束时间', { exact: true }).fill('10:00');
  await page.getByText('关联节点或待办（可选）', { exact: true }).click();
  const candidate = page.locator('.actual-pool-choice').filter({ hasText: '找人要材料' });
  await candidate.getByRole('button', { name: '加入', exact: true }).click();
  await page.getByLabel('本次完成 找人要材料', { exact: true }).check();
  await page.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(page.getByLabel('具体事件', { exact: true })).toHaveValue('');
  await nav(page, '今日已做');
  await expect(page.locator('.mobile-total')).toContainText('1.0');
  await expect(page.getByText('在手机上完成材料整理', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑记录 · 在手机上完成材料整理' }).click();
  await page.getByRole('dialog').getByLabel('具体事件', { exact: true }).fill('修改后的实际记录');
  await page.getByRole('dialog').getByRole('button', { name: '保存实际工作' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('修改后的实际记录', { exact: true })).toBeVisible();
});

test('笔记复用导览，随手记保留原正文且未保存内容有离开保护', async ({ page }) => {
  const data = await snapshot(page),
    line = data.entries.find((entry) => entry.data.type === 'workline')!;
  await nav(page, '笔记');
  await page.getByRole('button', { name: '打开业务线 论文研究', exact: true }).click();
  await page.getByLabel('随手记', { exact: true }).fill('手机上的一个新想法');
  page.once('dialog', (dialog) => dialog.dismiss());
  await nav(page, '工作空间');
  await expect(page.getByLabel('随手记', { exact: true })).toHaveValue('手机上的一个新想法');
  await page.getByRole('button', { name: '记到笔记', exact: true }).click();
  await expect(page.getByLabel('随手记', { exact: true })).toHaveValue('');
  expect(await notes(page, line.data.id)).toContain('手机上的一个新想法');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByLabel('Notes 正文', { exact: true }).fill('原有正文与手机编辑');
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await expect(page.getByText('原有正文与手机编辑', { exact: true })).toBeVisible();
});

test('新增节点和待办沿用同一表单；手机样式不影响桌面四页', async ({ page }) => {
  await nav(page, '编辑');
  await page.getByRole('button', { name: '待办／节点', exact: true }).click();
  await page.getByLabel('类型', { exact: true }).selectOption('milestone');
  await page.getByLabel('业务线', { exact: true }).selectOption({ label: '论文研究' });
  await page.getByLabel('要做什么', { exact: true }).fill('手机新增节点');
  await page.getByLabel('截止日期', { exact: true }).fill(localDay());
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByLabel('要做什么', { exact: true })).toHaveValue('');
  expect(
    (await snapshot(page)).entries.some(
      (entry) => entry.data.type === 'milestone' && entry.data.title === '手机新增节点',
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(
    page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button'),
  ).toHaveCount(4);
  await expect(page.locator('html')).not.toHaveAttribute('data-surface', 'android');
});

test('确认放弃草稿后打开设置，返回表单已清空，不留下无保护的旧输入', async ({ page }) => {
  await nav(page, '编辑');
  await page.getByLabel('具体事件', { exact: true }).fill('明确放弃的草稿');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(page.getByLabel('具体事件', { exact: true })).toHaveValue('');
});
