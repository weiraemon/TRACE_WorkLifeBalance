import { expect, test } from '@playwright/test';
import { connect } from './helpers';
import { recordContract } from '../../packages/domain/index';

test('手机读取目录时显示进度与计时，取消后可重试', async ({ page }) => {
  await connect(page);
  await page.route('**/api/session', () => {});
  await page.goto('/?ui=android');
  const progress = page.getByRole('region', { name: '操作进度', exact: true });
  await expect(progress).toContainText('正在读取工作目录');
  await expect(progress).toContainText('已用 1 秒');
  await progress.getByRole('button', { name: '停止本次操作' }).click();
  await expect(progress).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('操作已停止');
  await page.unroute('**/api/session');
  await page.getByRole('button', { name: '重新读取原目录' }).click();
  await expect(page.getByRole('navigation', { name: '今日导航', exact: true })).toBeVisible();
});

test('读取电脑变化等待响应时显示进度，可停止并显示超时错误', async ({ page }) => {
  await connect(page);
  await page.goto('/?ui=android');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const wifi = page.getByRole('region', { name: 'Wi-Fi 直连', exact: true });
  await wifi
    .getByLabel('电脑配对连接')
    .fill(
      'http://127.0.0.1:4321/chaos-exchange/00000000-0000-0000-0000-000000000000#00000000000000000000000000000000',
    );
  await page.route('**/api/wifi/request', () => {});
  await wifi.getByRole('button', { name: '读取电脑变化', exact: true }).click();
  const progress = page.getByRole('region', { name: '操作进度', exact: true });
  await expect(progress).toContainText('正在读取电脑变化');
  await expect(progress).toContainText('正在连接电脑并等待响应');
  await progress.getByRole('button', { name: '停止本次操作' }).click();
  await expect(wifi.getByRole('alert')).toContainText('操作已停止');
  await expect(wifi.getByRole('button', { name: '读取电脑变化' })).toBeEnabled();
  await page.unroute('**/api/wifi/request');
  await page.route('**/api/wifi/request', (route) =>
    route.fulfill({
      status: 504,
      headers: { 'X-Atlas-Contract': recordContract },
      json: { error: '连接电脑超时，请检查 Wi-Fi' },
    }),
  );
  await wifi.getByRole('button', { name: '读取电脑变化', exact: true }).click();
  await expect(wifi.getByRole('alert')).toContainText('连接电脑超时');
  await expect(progress).toHaveCount(0);
});
