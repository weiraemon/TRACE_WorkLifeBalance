import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { connect, seed, refresh, snapshot, notes, headers } from './helpers';
import { emptyInbox } from '../../packages/domain/messages';
import { writeInboxText } from '../../apps/local-service/src/sync/message-store';

async function openSync(page: Page, kind: 'QQ' | '微信') {
  await page.getByRole('button', { name: '备份', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: kind + '同步设置', exact: true })
    .click();
}

test('消息规则、AI 提供商、QQ 项目范围与计划入库', async ({ page }) => {
  await fs.rm('.test-vault/app-config', { recursive: true, force: true });
  await connect(page);
  const { project, line } = await seed(page);
  await refresh(page);
  await openSync(page, 'QQ');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('支持本机 QQ 自动同步');
  await dialog.getByRole('button', { name: 'QQ手动同步', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '开始手动同步', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();

  await openSync(page, '微信');
  const wechat = page.getByRole('dialog');
  await expect(wechat).toContainText('微信同步尚未接入');
  await wechat.getByRole('button', { name: '微信手动同步', exact: true }).click();
  await expect(wechat.getByRole('button', { name: '开始手动同步', exact: true })).toBeDisabled();
  await wechat.getByRole('button', { name: '关闭对话框', exact: true }).click();

  await openSync(page, 'QQ');
  await dialog.getByRole('button', { name: '模型设置', exact: true }).click();

  // AI provider settings and per-provider keys persist in the app config file.
  await expect(dialog.getByLabel('模型提供商')).toHaveValue('deepseek');
  await expect(dialog.getByLabel('接口地址')).toHaveValue('https://api.deepseek.com');
  await expect(dialog.getByLabel('模型名称')).toHaveValue('deepseek-flash');
  await expect(dialog).toContainText('DeepSeek：密钥未配置');
  await dialog.getByLabel('API 密钥').fill('sk-e2e-deepseek');
  await dialog.getByRole('button', { name: '保存 AI 设置', exact: true }).click();
  await expect(dialog).toContainText('AI 设置与密钥已保存到本机');
  await expect(dialog).toContainText('DeepSeek：密钥已保存');
  await expect(dialog).toContainText('当前配置可用于识别');

  await dialog.getByLabel('模型提供商').selectOption('openai');
  await expect(dialog.getByLabel('接口地址')).toHaveValue('https://api.openai.com/v1');
  await expect(dialog).toContainText('OpenAI / ChatGPT：密钥未配置');
  await dialog.getByLabel('模型名称').fill('gpt-e2e');
  await dialog.getByLabel('API 密钥').fill('sk-e2e-openai');
  await dialog.getByRole('button', { name: '保存 AI 设置', exact: true }).click();
  await expect(dialog).toContainText('OpenAI / ChatGPT：密钥已保存');

  // Switching back restores that provider's own settings and key.
  await dialog.getByLabel('模型提供商').selectOption('deepseek');
  await expect(dialog.getByLabel('模型名称')).toHaveValue('deepseek-flash');
  await expect(dialog).toContainText('DeepSeek：密钥已保存');
  await dialog.getByRole('button', { name: '清除此提供商的密钥', exact: true }).click();
  await expect(dialog).toContainText('已清除此提供商的密钥');
  await expect(dialog).toContainText('DeepSeek：密钥未配置');
  await dialog.getByLabel('模型提供商').selectOption('openai');
  await expect(dialog).toContainText('OpenAI / ChatGPT：密钥已保存');
  await dialog.getByRole('button', { name: '清除此提供商的密钥', exact: true }).click();
  await expect(dialog).toContainText('OpenAI / ChatGPT：密钥未配置');

  await dialog.getByRole('button', { name: 'QQ自动同步全局设置', exact: true }).click();
  await expect(dialog).toContainText('QQ 自动同步');
  await expect(dialog.getByLabel('QQ 数据目录')).toBeVisible();
  await expect(dialog.getByLabel('QQ 数据库密钥')).toBeVisible();
  await dialog.getByLabel('本人姓名与称呼').fill('张三，小张');
  await dialog.getByLabel('班级名称与简称').fill('软件一班');
  await dialog.getByRole('button', { name: '保存全局设置', exact: true }).click();
  await expect(dialog).toContainText('全局设置已保存');

  await dialog.getByRole('button', { name: '会话规则设置', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '读取 QQ 列表', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '添加群聊规则', exact: true }).click();
  await dialog.getByLabel('会话名称').fill('年级通知');
  await expect(dialog.getByLabel('自动加入计划（跳过待确认）')).not.toBeChecked();
  await dialog.getByLabel('检查范围').selectOption('conditions');
  await dialog.getByLabel('@全体成员', { exact: true }).check();
  await dialog.getByLabel('限定项目（可选）').selectOption(project.data.id);
  await dialog.getByLabel('默认业务线（可选）').selectOption(line.data.id);
  await dialog.getByRole('button', { name: '保存此规则', exact: true }).click();
  await expect(dialog).toContainText('此规则已保存');
  await dialog.getByRole('button', { name: '收拢详细', exact: true }).click();
  await expect(dialog.getByLabel('会话名称')).toHaveCount(0);
  await dialog.getByRole('button', { name: '展开详细', exact: true }).click();
  await expect(dialog.getByLabel('会话名称')).toHaveValue('年级通知');
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await openSync(page, 'QQ');
  await dialog.getByRole('button', { name: '会话规则设置', exact: true }).click();
  await expect(dialog.getByLabel('会话名称')).toHaveValue('年级通知');
  await expect(dialog.getByLabel('限定项目（可选）')).toHaveValue(project.data.id);
  await expect(dialog.getByLabel('默认业务线（可选）')).toHaveValue(line.data.id);
  await dialog.getByRole('button', { name: 'QQ自动同步全局设置', exact: true }).click();
  await expect(dialog.getByLabel('本人姓名与称呼')).toHaveValue('张三，小张');
  await dialog.getByRole('button', { name: '会话规则设置', exact: true }).click();

  // Project-only conversation: no default line; analysis must create inside the project.
  await dialog.getByLabel('默认业务线（可选）').selectOption('');
  await dialog.getByRole('button', { name: '保存所有规则', exact: true }).click();
  await expect(dialog).toContainText('所有规则已保存');
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await openSync(page, 'QQ');
  await dialog.getByRole('button', { name: '会话规则设置', exact: true }).click();
  await expect(dialog.getByLabel('限定项目（可选）')).toHaveValue(project.data.id);
  await expect(dialog.getByLabel('默认业务线（可选）')).toHaveValue('');
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();

  // Fixture only: the production app has no endpoint to fabricate AI responses.
  const current = await snapshot(page);
  const state = emptyInbox();
  state.candidates.push(
    {
      id: randomUUID(),
      fingerprint: 'b'.repeat(64),
      raw: false,
      conversation: '年级通知',
      projectId: null,
      lineId: line.data.id,
      receivedAt: new Date().toISOString(),
      source: {
        ruleId: randomUUID(),
        sender: '辅导员',
        sentAt: '2026-10-28T08:00:00+08:00',
        text: '周五前交登记表',
        context: '',
        atAll: true,
        atMe: false,
        remoteId: null,
        fromSelf: false,
      },
      suggestion: {
        kind: 'task',
        targetId: null,
        completed: false,
        title: '交登记表',
        dueDate: '2026-10-30',
        dueTime: '17:00',
        reason: '要求提交',
        uncertainty: '请核对日期',
        actions: ['交登记表'],
        tags: [],
        location: null,
      },
    },
    {
      id: randomUUID(),
      fingerprint: 'c'.repeat(64),
      raw: false,
      conversation: '年级通知',
      projectId: null,
      lineId: null,
      receivedAt: new Date().toISOString(),
      source: {
        ruleId: randomUUID(),
        sender: '学院教务',
        sentAt: '2026-10-28T09:00:00+08:00',
        text: '寒期项目开始申报，11月2日前报名',
        context: '',
        atAll: true,
        atMe: false,
        remoteId: null,
        fromSelf: false,
      },
      suggestion: {
        kind: 'event',
        targetId: null,
        completed: false,
        title: '寒期项目报名',
        dueDate: '2026-11-02',
        dueTime: '18:00',
        reason: '与当前学业事务无关',
        uncertainty: '',
        actions: ['填写报名表'],
        tags: ['报告'],
        location: '线上',
        destination: {
          kind: 'newProject',
          projectTitle: '寒期项目',
          lineTitle: '申报',
          reason: '现有业务线都不涉及项目申报',
        },
      },
    },
  );
  const file = path.join(current.root, '.atlas/qq-inbox.md');
  await fs.writeFile(file, writeInboxText(await fs.readFile(file, 'utf8'), state));
  await openSync(page, 'QQ');
  await expect(dialog.getByRole('heading', { name: '交登记表', exact: true })).toBeVisible();
  const defaultCard = dialog.locator('article.message-candidate').filter({ hasText: '交登记表' });
  await expect(defaultCard).toContainText('已使用会话默认业务线');
  await defaultCard.getByLabel('事项标题').fill('登记表截止');
  await defaultCard.getByRole('button', { name: '确认加入计划', exact: true }).click();
  await expect(dialog).toContainText('已加入计划');
  await expect(dialog.getByRole('button', { name: '待确认（1）', exact: true })).toBeVisible();
  const afterDefault = await snapshot(page);
  expect(
    afterDefault.entries.some((e) => e.data.type === 'milestone' && e.data.title === '登记表截止'),
  ).toBe(true);
  expect(await notes(page, line.data.id)).toContain('周五前交登记表');

  const projectCard = dialog
    .locator('article.message-candidate')
    .filter({ hasText: '寒期项目报名' });
  await expect(projectCard).toContainText('AI 推荐新建项目与业务线，可修改名称。');
  await expect(projectCard.getByLabel('新项目名称')).toHaveValue('寒期项目');
  await expect(projectCard.getByLabel('新业务线名称')).toHaveValue('申报');
  await projectCard.getByLabel('新业务线名称').fill('申报事务');
  await projectCard.getByRole('button', { name: '确认加入计划', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '待确认（0）', exact: true })).toBeVisible();
  const afterProject = await snapshot(page);
  const createdProject = afterProject.entries.find(
    (e) => e.data.type === 'project' && e.data.title === '寒期项目',
  );
  expect(createdProject).toBeTruthy();
  const createdLine = afterProject.entries.find(
    (e) =>
      e.data.type === 'workline' &&
      e.data.title === '申报事务' &&
      e.data.projectId === createdProject!.data.id,
  );
  expect(createdLine).toBeTruthy();
  expect(await notes(page, createdLine!.data.id)).toContain('寒期项目开始申报');
  await page.screenshot({ path: '.test-vault/messages-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(dialog).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.test-vault/messages-mobile.png', fullPage: true });
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(page.getByRole('region', { name: '做了什么', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'QQ同步设置', exact: true })).toHaveCount(0);
});

test('会话开启自动加入后，命中消息直接进入计划', async ({ page }) => {
  await fs.rm('.test-vault/app-config', { recursive: true, force: true });
  const content = JSON.stringify({
    suggestions: [
      {
        kind: 'task',
        title: '自动加入测试',
        dueDate: null,
        dueTime: null,
        reason: '测试通知',
        uncertainty: '',
        actions: [],
        destination: null,
      },
    ],
  });
  const mock = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content } }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const { port } = mock.address() as AddressInfo;
  try {
    await connect(page);
    const { line } = await seed(page);
    await refresh(page);
    await openSync(page, 'QQ');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '模型设置', exact: true }).click();
    await dialog.getByLabel('模型提供商').selectOption('custom');
    await dialog.getByLabel('接口地址').fill(`http://127.0.0.1:${port}/v1`);
    await dialog.getByLabel('模型名称').fill('mock');
    await dialog.getByLabel('API 密钥').fill('sk-mock');
    await dialog.getByRole('button', { name: '保存 AI 设置', exact: true }).click();
    await expect(dialog).toContainText('AI 设置与密钥已保存到本机');
    await dialog.getByRole('button', { name: 'QQ自动同步全局设置', exact: true }).click();
    await dialog.getByLabel('本人姓名与称呼').fill('测试');
    await dialog.getByRole('button', { name: '保存全局设置', exact: true }).click();
    await expect(dialog).toContainText('全局设置已保存');
    await dialog.getByRole('button', { name: '会话规则设置', exact: true }).click();
    await dialog.getByRole('button', { name: '添加群聊规则', exact: true }).click();
    await dialog.getByLabel('会话名称').fill('自动测试');
    await dialog.getByLabel('自动加入计划（跳过待确认）').check();
    await dialog.getByLabel('默认业务线（可选）').selectOption(line.data.id);
    await dialog.getByRole('button', { name: '保存此规则', exact: true }).click();
    await expect(dialog).toContainText('此规则已保存');
    await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();

    await openSync(page, 'QQ');
    const inbox = page.getByRole('dialog');
    await inbox.getByText('粘贴 QQ 消息进行识别', { exact: true }).click();
    await inbox.getByLabel('来源会话').selectOption({ label: '群聊 · 自动测试' });
    await inbox.getByLabel('发送人').fill('辅导员');
    await inbox.getByLabel('消息发送时间（北京时间）').fill('2026-10-29T09:00');
    await inbox.getByLabel('消息正文').fill('请在明天前完成自动加入测试');
    await inbox.getByRole('button', { name: /按规则筛选并发送给/ }).click();
    await expect(inbox).toContainText('已自动加入 1 项计划');
    await inbox.getByRole('button', { name: '关闭对话框', exact: true }).click();

    const after = await snapshot(page);
    expect(
      after.entries.some((e) => e.data.type === 'todo' && e.data.title === '自动加入测试'),
    ).toBe(true);
    const messages = await page.request
      .get('/api/messages', { headers: await headers(page) })
      .then((r) => r.json());
    expect(messages.state.candidates).toHaveLength(0);
  } finally {
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  }
});
