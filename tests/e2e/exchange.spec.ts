import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { connect, seed, snapshot, write } from './helpers';
import type { ExchangeBundle, ExchangeReceipt } from '../../packages/domain/exchange';
import { headers } from './helpers';

async function settings(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByText('离线文件交换', { exact: true }).click();
  return page.getByRole('region', { name: '设备增量交换' });
}
test('电脑手动开启和关闭独立 Wi-Fi 会话，常规业务接口不对局域网开放', async ({ page }) => {
  await connect(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const wifi = page.getByRole('region', { name: 'Wi-Fi 直连', exact: true });
  const status = await page.request
    .get('/api/wifi/status', { headers: await headers(page) })
    .then((response) => response.json());
  test.skip(!status.addresses.length, '本机没有可绑定的私有 IPv4 接口');
  await wifi.getByLabel('电脑局域网地址').selectOption(status.addresses[0].address);
  await wifi.getByRole('button', { name: '开启 Wi-Fi 连接', exact: true }).click();
  await expect(wifi.getByLabel('电脑配对连接', { exact: true })).toHaveValue(
    /^http:.*#[a-f0-9]{32}$/,
  );
  await wifi.getByRole('button', { name: '关闭 Wi-Fi 连接', exact: true }).click();
  await expect(wifi.getByRole('button', { name: '开启 Wi-Fi 连接', exact: true })).toBeVisible();
  expect(
    (
      await page.request
        .get('/api/wifi/status', { headers: await headers(page) })
        .then((response) => response.json())
    ).running,
  ).toBe(false);
});
test('桌面发送，手机导入并返回回执，后续只传变化；文件可下载，预览过期与冲突不覆盖', async ({
  page,
}) => {
  await connect(page);
  await seed(page);
  const source = (await snapshot(page)).root;
  let exchange = await settings(page);
  await exchange.getByRole('button', { name: '生成发送包', exact: true }).click();
  await exchange.getByText('查看 JSON', { exact: true }).click();
  const bundle = JSON.parse(
    await exchange.getByLabel('导出的交换 JSON').inputValue(),
  ) as ExchangeBundle;
  const downloadEvent = page.waitForEvent('download');
  await exchange.getByRole('button', { name: '保存发送包', exact: true }).click();
  expect((await downloadEvent).suggestedFilename()).toMatch(/^CHAOS-changes-.*\.json$/);
  const target = await fs.mkdtemp(path.resolve('.test-vault/exchange-ui-'));
  await page.getByRole('dialog').getByLabel('工作目录绝对路径').fill(target);
  await page.getByRole('dialog').getByRole('button', { name: '连接工作目录', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/?ui=android');
  await page.setViewportSize({ width: 390, height: 844 });
  exchange = await settings(page);
  await exchange.getByLabel('打开交换文件或回执').setInputFiles({
    name: 'changes.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bundle)),
  });
  await expect(exchange.getByLabel('交换预览')).toContainText('新增');
  await exchange.getByRole('button', { name: '确认导入并生成回执', exact: true }).click();
  await expect(exchange.getByRole('status')).toContainText('已导入');
  await exchange.getByText('查看 JSON', { exact: true }).click();
  const receipt = JSON.parse(
    await exchange.getByLabel('导出的交换 JSON').inputValue(),
  ) as ExchangeReceipt;
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page
    .getByRole('navigation', { name: '手机导航' })
    .getByRole('button', { name: '工作空间', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: '打开业务线 论文研究', exact: true }),
  ).toBeVisible();
  // Return to the source without relying on the previous directory's receipt cache.
  await page.goto('/');
  await settings(page);
  await page.getByRole('dialog').getByLabel('工作目录绝对路径').fill(source);
  await page.getByRole('dialog').getByRole('button', { name: '连接工作目录', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await write(page, 'project', { title: '首次交换后新增' });
  exchange = await settings(page);
  await exchange.getByLabel('打开交换文件或回执').setInputFiles({
    name: 'receipt.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(receipt)),
  });
  await expect(exchange.getByRole('status')).toContainText('共同版本');
  await exchange.getByRole('button', { name: '生成发送包', exact: true }).click();
  await expect(exchange).toContainText('发送包：1 个变化');
  await exchange.getByText('查看 JSON', { exact: true }).click();
  const delta = JSON.parse(
    await exchange.getByLabel('导出的交换 JSON').inputValue(),
  ) as ExchangeBundle;
  await page.getByRole('dialog').getByLabel('工作目录绝对路径').fill(target);
  await page.getByRole('dialog').getByRole('button', { name: '连接工作目录', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  exchange = await settings(page);
  await exchange.getByLabel('打开交换文件或回执').setInputFiles({
    name: 'delta.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(delta)),
  });
  await expect(exchange.getByLabel('交换预览')).toBeVisible();
  await write(page, 'project', { title: '预览后的外部变化' });
  await exchange.getByRole('button', { name: '确认导入并生成回执', exact: true }).click();
  await expect(exchange.getByRole('alert')).toContainText('预览');
  expect(
    (await snapshot(page)).entries.some(
      (entry) => 'title' in entry.data && entry.data.title === '首次交换后新增',
    ),
  ).toBe(false);
});
