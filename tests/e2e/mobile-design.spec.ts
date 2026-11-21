import { expect, test } from '@playwright/test';
import { connect, seed, localDay, selectTime } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test.beforeEach(async ({ page }) => {
  await connect(page);
  await seed(page);
  await page.goto('/?ui=android');
});

test('移动端新增分组、单一主操作、自定义日期和成功提示', async ({ page }) => {
  await page.getByRole('button', { name: '工作空间', exact: true }).click();
  await page.getByRole('button', { name: '打开业务线 论文研究', exact: true }).click();
  await page.getByRole('button', { name: '添加节点', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新增节点', exact: true });
  await expect(dialog.locator('.primary')).toHaveCount(1);
  await expect(dialog.locator('.mobile-form-options')).not.toHaveAttribute('open');
  await expect(dialog.locator('.date-time-input').first()).toContainText('未定');
  await dialog.getByLabel('标题', { exact: true }).fill('核对实验结果');
  await dialog.getByLabel('截止日期', { exact: true }).fill(localDay());
  await page.screenshot({
    path: 'test-results/mobile-design-node-collapsed.png',
    animations: 'disabled',
  });
  await dialog.getByText('更多选项', { exact: true }).click();
  await dialog.getByRole('button', { name: '重要性：一般', exact: true }).click();
  await dialog.getByLabel('批注 / 纪要', { exact: true }).fill('带上实验记录');
  for (const width of [320, 390, 640]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['sage', 'blue']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeInViewport();
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(
        (await dialog.getByRole('button', { name: '重要性：一般', exact: true }).boundingBox())!
          .height,
      ).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `test-results/mobile-design-node-${width}-${theme}.png` });
    }
  }
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.mobile-save-feedback').filter({ hasText: '已保存' })).toBeVisible();
});

test('原有时间格与紧凑录入、时间摘要共存', async ({ page }) => {
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const grid = page.getByRole('group', { name: '一天的 48 个半小时', exact: true });
  await expect(grid.locator('button')).toHaveCount(48);
  await expect(grid.locator('.time-period')).toHaveCount(0);
  await expect(grid).not.toHaveClass(/mobile-time-grid/);
  await expect(grid.locator('button').first()).toHaveCSS('border-radius', '4px');
  await expect(grid.locator('button').first()).toHaveCSS('font-size', '11px');
  await selectTime(page, '13:00', '14:00');
  await expect(page.getByLabel('已选时间', { exact: true })).toHaveText('13:00–14:00 · 60 分钟');
  await expect(grid.locator('button[aria-pressed="true"]')).toHaveCount(2);
  await expect(grid.locator('button[aria-pressed="true"]').first()).toHaveCSS(
    'background-color',
    'rgb(65, 90, 66)',
  );
  await expect(page.getByLabel('具体事件', { exact: true })).toHaveAttribute('rows', '3');
  for (const width of [320, 390, 640]) {
    await page.setViewportSize({ width, height: 844 });
    expect((await grid.locator('button').first().boundingBox())!.height).toBe(34);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/mobile-design-actual-${width}.png`,
      animations: 'disabled',
    });
  }
  await page.getByLabel('具体事件', { exact: true }).fill('整理实验记录');
  await page.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(page.locator('.mobile-save-feedback').filter({ hasText: '已保存' })).toBeVisible();
});

test('新增待办与快速创建保持同一视觉分组', async ({ page }) => {
  await page.getByRole('button', { name: '工作空间', exact: true }).click();
  await page.getByRole('button', { name: '打开业务线 论文研究', exact: true }).click();
  await page.getByRole('button', { name: '添加 TODO / IDEA · 方案会议', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新增TODO', exact: true });
  await expect(dialog.locator('.primary')).toHaveCount(1);
  await expect(dialog.getByLabel('内容类型', { exact: true })).toBeVisible();
  await expect(dialog.locator('.mobile-form-options')).not.toHaveAttribute('open');
  await dialog.getByLabel('标题', { exact: true }).fill('整理会前材料');
  await page.screenshot({ path: 'test-results/mobile-design-todo.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('button', { name: '待办／节点', exact: true }).click();
  await expect(page.locator('.mobile-capture-form .mobile-form-options')).not.toHaveAttribute(
    'open',
  );
  await page.screenshot({ path: 'test-results/mobile-design-capture.png', animations: 'disabled' });
});
