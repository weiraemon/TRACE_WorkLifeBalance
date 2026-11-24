import { expect, test } from '@playwright/test';
import { connect, seed, write, localDay, snapshot } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test.beforeEach(async ({ page }) => {
  await connect(page);
  await seed(page);
  await page.goto('/?ui=android');
});

test('手机按控件类型统一边框，普通输入与标签候选使用各自样式', async ({ page }) => {
  await page.getByRole('button', { name: '工作空间', exact: true }).click();
  await expect(page.locator('input[type="search"]')).toHaveCSS('border-top-width', '0px');
  await page.getByRole('button', { name: '打开业务线 论文研究', exact: true }).click();
  await page.getByRole('button', { name: '添加节点', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新增节点', exact: true });
  await expect(dialog.getByLabel('标题', { exact: true })).toHaveCSS('border-top-width', '2px');
  await expect(dialog.getByLabel('节点标签', { exact: true })).toHaveCSS('border-top-width', '1px');
  await expect(dialog.getByLabel('截止日期', { exact: true })).toHaveCSS('border-top-width', '0px');
  await page.screenshot({ path: 'test-results/mobile-controls.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('button', { name: '待办／节点', exact: true }).click();
  await page.getByRole('button', { name: '类型', exact: true }).click();
  await page.getByRole('option', { name: '节点', exact: true }).click();
  await expect(page.getByLabel('节点标签', { exact: true })).toHaveCSS('border-top-width', '1px');
  await expect(page.getByLabel('要做什么', { exact: true })).toHaveCSS('border-top-width', '2px');
  await expect(page.getByRole('button', { name: '类型', exact: true })).toHaveCSS(
    'border-top-width',
    '1px',
  );
});

test('已做长按遇到触摸系统菜单仍进入关联，松手不会打开编辑', async ({ page }) => {
  const actual = await write(page, 'actual', {
    date: localDay(),
    startTime: '08:00',
    endTime: '09:00',
    description: '触摸关联回归',
  });
  await page.reload();
  await page.getByRole('button', { name: '今日已做', exact: true }).click();
  const record = page.locator(`[data-actual-id="${actual.data.id}"]`);
  await record.dispatchEvent('pointerdown', {
    pointerType: 'touch',
    button: 0,
    clientX: 100,
    clientY: 200,
  });
  await record.dispatchEvent('contextmenu');
  const mode = page.getByRole('dialog', { name: '工作空间 · 关联模式', exact: true });
  await expect(mode).toBeVisible();
  await record.dispatchEvent('pointerup', { pointerType: 'touch' });
  await record.locator('button').dispatchEvent('click');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await mode.getByRole('button', { name: '打开业务线 论文研究', exact: true }).click();
  await mode.getByRole('checkbox', { name: '关联节点 方案会议', exact: true }).click();
  await mode.getByRole('button', { name: '保存', exact: true }).click();
  await expect(mode).toHaveCount(0);
  const saved = await snapshot(page);
  const node = saved.entries.find(
    ({ data }) => data.type === 'milestone' && data.title === '方案会议',
  )!;
  expect(saved.entries.find(({ data }) => data.id === actual.data.id)?.data).toMatchObject({
    milestoneIds: [node.data.id],
  });
  await record.locator('button').click();
  await expect(page.getByRole('dialog').getByLabel('具体事件', { exact: true })).toBeVisible();
});

test('浏览器真实触摸长按已做记录进入关联模式', async ({ page }) => {
  const actual = await write(page, 'actual', {
    date: localDay(),
    startTime: '08:00',
    endTime: '09:00',
    description: '真实触摸长按',
  });
  await page.reload();
  await page.getByRole('button', { name: '今日已做', exact: true }).click();
  const record = page.locator(`[data-actual-id="${actual.data.id}"] button`);
  const box = (await record.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
  });
  await expect(page.getByRole('dialog', { name: '工作空间 · 关联模式', exact: true })).toBeVisible();
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await session.detach();
});
