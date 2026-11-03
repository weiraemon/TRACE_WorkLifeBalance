import { test, expect } from '@playwright/test';
import { connect } from './helpers';

test('QQ 自动检测、浏览兜底、失败重试与成功刷新', async ({ page }) => {
  await connect(page);
  await page.evaluate(() => {
    window.chaosDesktop = {
      chooseDirectory: async () => null,
      discoverQq: async ({ browse }) => ({
        accounts: browse
          ? [
              {
                dataDir: 'D:/资料/987654321/nt_qq/nt_db',
                selfQQ: '987654321',
                modified: '2026-11-04T01:00:00Z',
              },
            ]
          : [],
        limited: false,
      }),
      setupQq: async (input) => {
        sessionStorage.setItem('qq-setup-input', JSON.stringify(input));
        if (!sessionStorage.getItem('qq-setup-retry')) {
          sessionStorage.setItem('qq-setup-retry', 'yes');
          throw new Error('初始化未完成');
        }
      },
    };
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: 'QQ同步设置', exact: true }).click();
  await page.getByRole('button', { name: '初始化 QQ 数据库读取…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '初始化 QQ 数据库读取', exact: true });
  await expect(dialog).toContainText('未找到账号');
  await expect(dialog.getByRole('button', { name: '启动初始化工具', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '选择文件夹查找…', exact: true }).click();
  await expect(dialog.getByLabel('选择 QQ 账号')).toHaveValue('D:/资料/987654321/nt_qq/nt_db');
  await dialog.getByRole('button', { name: '启动初始化工具', exact: true }).click();
  await expect(dialog).toContainText('初始化未完成');
  const refreshed = page.waitForResponse(
    (r) => r.url().endsWith('/messages') && r.request().method() === 'GET',
  );
  await dialog.getByRole('button', { name: '启动初始化工具', exact: true }).click();
  await refreshed;
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qq-setup-input')!))).toEqual({
    dataDir: 'D:/资料/987654321/nt_qq/nt_db',
    selfQQ: '987654321',
  });
  await expect(
    page.getByText('QQ 初始化成功，已自动刷新配置。可以手动关闭命令行窗口。'),
  ).toBeVisible();
});

test('多个 QQ 账号必须手动选择，取消浏览或初始化不启动脚本', async ({ page }) => {
  await connect(page);
  await page.evaluate(() => {
    window.chaosDesktop = {
      chooseDirectory: async () => null,
      discoverQq: async ({ browse }) =>
        browse
          ? null
          : {
              accounts: [
                {
                  dataDir: 'D:/QQ/123456/nt_db',
                  selfQQ: '123456',
                  modified: '2026-11-04T01:00:00Z',
                },
                {
                  dataDir: 'D:/QQ/987654/nt_db',
                  selfQQ: '987654',
                  modified: '2026-11-03T01:00:00Z',
                },
              ],
              limited: false,
            },
      setupQq: async () => {
        sessionStorage.setItem('unexpected-setup', 'yes');
      },
    };
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: 'QQ同步设置', exact: true }).click();
  await page.getByRole('button', { name: '初始化 QQ 数据库读取…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '初始化 QQ 数据库读取', exact: true });
  await expect(dialog.getByLabel('选择 QQ 账号').getByRole('option')).toHaveCount(3);
  await expect(dialog.getByRole('button', { name: '启动初始化工具', exact: true })).toBeDisabled();
  await dialog.getByLabel('选择 QQ 账号').selectOption('D:/QQ/987654/nt_db');
  await dialog.getByRole('button', { name: '选择文件夹查找…', exact: true }).click();
  await expect(dialog.getByLabel('选择 QQ 账号')).toHaveValue('D:/QQ/987654/nt_db');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('unexpected-setup'))).toBeNull();
});
