import { expect, test } from '@playwright/test';
import { connect, seed, write, nav as desktopNav } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('节点详情使用整页、正文留白和图标操作，返回保留位置与草稿，桌面仍使用侧栏', async ({
  page,
}) => {
  await connect(page);
  const { line } = await seed(page);
  for (let index = 0; index < 5; index++)
    await write(page, 'milestone', { title: `前置节点 ${index}`, lineId: line.data.id });
  const title = '讨论实验边界条件与下一步安排的一个比较长的节点名称';
  const target = await write(page, 'milestone', { title, lineId: line.data.id });
  await page.goto('/?ui=android');
  await page
    .getByRole('navigation', { name: '手机导航' })
    .getByRole('button', { name: '工作空间', exact: true })
    .click();
  await page.getByRole('button', { name: '打开业务线 论文研究', exact: true }).click();
  const trigger = page
    .getByRole('article', { name: `节点 · ${title}`, exact: true })
    .locator('.mobile-node-heading button');
  await trigger.scrollIntoViewIfNeeded();
  const scroll = await page.locator('.mobile-main').evaluate((element) => element.scrollTop);
  await trigger.click();
  const detail = page.getByRole('complementary', { name: '工作详情' });
  await expect(detail).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '手机导航' })).toHaveCount(0);
  expect(
    await detail.evaluate((element) => ({
      position: getComputedStyle(element).position,
      shadow: getComputedStyle(element).boxShadow,
    })),
  ).toEqual({ position: 'static', shadow: 'none' });
  const more = page.getByRole('button', { name: '更多操作', exact: true });
  await expect(more).toHaveText('');
  for (const width of [320, 390, 640]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['sage', 'blue']) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      const bounds = await detail.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(24);
      expect(width - bounds!.x - bounds!.width).toBeGreaterThanOrEqual(24);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (width === 390) await page.screenshot({ path: `.test-vault/mobile-detail-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await more.click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: '编辑', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await detail.getByRole('button', { name: '编辑内容', exact: true }).click();
  await detail.getByLabel('内部正文', { exact: true }).fill('返回后继续编辑的正文');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect
    .poll(() => page.locator('.mobile-main').evaluate((element) => element.scrollTop))
    .toBe(scroll);
  await trigger.click();
  await expect(detail.getByLabel('内部正文', { exact: true })).toHaveValue('返回后继续编辑的正文');
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await page.goto('/');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await desktopNav(page, '工作空间');
  await page.locator(`[data-space-id="${target.data.id}"] .point-title`).click();
  expect(
    await page
      .getByRole('complementary', { name: '工作详情' })
      .evaluate((element) => getComputedStyle(element).position),
  ).toBe('fixed');
});
