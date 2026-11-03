import { test, expect } from '@playwright/test';
import { connect } from './helpers';

test('QQ 初始化预填参数，取消不启动，启动失败保留输入并允许重试', async ({ page }) => {
  await connect(page);
  await page.evaluate(() => {
    window.chaosDesktop = {
      chooseDirectory: async () => null,
      setupQq: async (input) => {
        sessionStorage.setItem('qq-setup-input', JSON.stringify(input));
        if (!sessionStorage.getItem('qq-setup-retry')) {
          sessionStorage.setItem('qq-setup-retry', 'yes');
          throw new Error('无法打开 QQ 初始化工具');
        }
      },
    };
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: 'QQ同步设置', exact: true }).click();
  await page.getByLabel('QQ 数据目录', { exact: true }).fill('D:\\QQ data\\123456789\\nt_qq');
  await page.getByLabel('本人 QQ 号', { exact: true }).fill('123456789');
  const open = page.getByRole('button', { name: '初始化 QQ 数据库读取…', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: '初始化 QQ 数据库读取', exact: true });
  await expect(dialog.getByLabel('初始化使用的 QQ 数据目录')).toHaveValue(
    'D:\\QQ data\\123456789\\nt_qq',
  );
  await expect(dialog.getByLabel('初始化使用的 QQ 号')).toHaveValue('123456789');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('qq-setup-input'))).toBeNull();
  await open.click();
  await dialog.getByLabel('初始化使用的 QQ 数据目录').fill('D:\\资料\\987654321\\nt_db');
  await dialog.getByLabel('初始化使用的 QQ 号').fill('987654321');
  await dialog.getByRole('button', { name: '启动初始化工具', exact: true }).click();
  await expect(dialog).toContainText('无法打开 QQ 初始化工具');
  await expect(dialog.getByLabel('初始化使用的 QQ 号')).toHaveValue('987654321');
  await dialog.getByRole('button', { name: '启动初始化工具', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('qq-setup-input')!))).toEqual({
    dataDir: 'D:\\资料\\987654321\\nt_db',
    selfQQ: '987654321',
  });
  await expect(
    page.getByText(
      '初始化工具已打开，请在弹出窗口中完成操作。成功后点击“重新加载 QQ 同步”读取新配置。',
    ),
  ).toBeVisible();
});
