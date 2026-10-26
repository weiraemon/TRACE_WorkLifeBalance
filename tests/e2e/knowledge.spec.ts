import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { connect, seed, nav, write, refresh, snapshot, notes, headers, localDay } from './helpers';

test.beforeEach(async ({ page }) => connect(page));

test('知识页复用业务导航，可编辑并预览业务线 Notes 的节点、TODO 与 IDEA 层级，并同步外部修改', async ({
  page,
}) => {
  const { project, line, node, todo, idea } = await seed(page);
  for (const [entry, text] of [
    [node, '会议结论：**先核实边界条件**。\n\n- 先校准\n- 再比较'],
    [todo, '已联系实验室，等待提供材料。'],
    [idea, '排除测量误差后再验证替代解释。'],
  ] as const) {
    const response = await page.request.post('/api/records', {
      headers: await headers(page),
      data: {
        data: entry.data,
        revision: entry.revision,
        options: { comments: [{ id: randomUUID(), targetId: entry.data.id, text }] },
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await write(page, 'todo', {
    title: '纯完成不记笔记',
    milestoneId: node.data.id,
    completedAt: new Date().toISOString(),
  });
  await write(page, 'workline', {
    title: '已结束研究',
    projectId: project.data.id,
    completedAt: new Date().toISOString(),
  });
  await refresh(page);
  const before = await notes(page, line.data.id);
  await nav(page, '知识');
  const explorer = page.getByRole('navigation', { name: '业务导航', exact: true });
  const content = page.getByRole('region', { name: '业务线 Notes', exact: true });
  await expect(content).toContainText('选择一条业务线查看 Notes');
  await explorer.getByRole('button', { name: '定位业务线 · 论文研究', exact: true }).click();
  await expect(
    content.getByRole('heading', { level: 1, name: '论文研究', exact: true }),
  ).toBeVisible();
  await expect(
    content.getByRole('heading', { level: 2, name: `${localDay()} 09:00 · 方案会议`, exact: true }),
  ).toBeVisible();
  await expect(
    content.getByRole('heading', { level: 3, name: 'TODO · 找人要材料', exact: true }),
  ).toBeVisible();
  await expect(
    content.getByRole('heading', { level: 3, name: 'IDEA · 验证替代解释', exact: true }),
  ).toBeVisible();
  await expect(content.locator('strong')).toHaveText('先核实边界条件');
  await expect(content.getByRole('listitem')).toHaveText(['先校准', '再比较']);
  await expect(content).toContainText('已联系实验室，等待提供材料。');
  await expect(content).toContainText('排除测量误差后再验证替代解释。');
  await expect(content).not.toContainText('atlas:');
  await expect(content).not.toContainText('纯完成不记笔记');
  await expect(page.getByRole('button', { name: '编辑正文', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新增项目', exact: true })).toHaveCount(0);
  expect(await notes(page, line.data.id)).toBe(before);

  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = content.getByLabel('Notes 正文', { exact: true });
  await editor.fill(`${before}\n\n## 随手补充\n\n今天继续补充实验记录。`);
  await content.getByRole('button', { name: '保存正文', exact: true }).click();
  await expect(content.getByRole('button', { name: '编辑正文', exact: true })).toBeVisible();
  await expect(content).toContainText('今天继续补充实验记录。');
  expect(await notes(page, line.data.id)).toContain('今天继续补充实验记录。');

  await page.screenshot({ path: '.test-vault/knowledge-notes-desktop.png', fullPage: true });
  const state = await snapshot(page);
  const lineData = state.entries.find((e) => e.data.id === line.data.id)!.data;
  if (lineData.type !== 'workline') throw new Error('不是业务线');
  const resource = state.entries.find((e) => e.data.id === lineData.notesId)!;
  await fs.appendFile(
    path.join(state.root, resource.path),
    '\n## 外部编辑纪要\n\n直接修改 Markdown 的内容。\n',
  );
  await refresh(page);
  await expect(content).toContainText('直接修改 Markdown 的内容。');
  await expect(
    explorer.getByRole('button', { name: '定位业务线 · 已结束研究', exact: true }),
  ).toHaveCount(0);
  await explorer.getByLabel('显示已完成项目 / 业务线', { exact: true }).check();
  await expect(
    explorer.getByRole('button', { name: '定位业务线 · 已结束研究', exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 600, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(
    content.getByRole('heading', { level: 1, name: '论文研究', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: '.test-vault/knowledge-notes-mobile.png', fullPage: true });
});

test('快速切换业务线不混入迟到的 Notes，搜索和无匹配提示与工作空间一致', async ({ page }) => {
  const { project, line } = await seed(page);
  const other = await write(page, 'workline', { title: '另一条线', projectId: project.data.id });
  await refresh(page);
  await nav(page, '知识');
  await page.route('**/api/content', async (route) => {
    const input = route.request().postDataJSON();
    if (input.id === line.data.id) await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  const explorer = page.getByRole('navigation', { name: '业务导航', exact: true });
  const content = page.getByRole('region', { name: '业务线 Notes', exact: true });
  await explorer.getByRole('button', { name: '定位业务线 · 论文研究', exact: true }).click();
  await explorer.getByRole('button', { name: '定位业务线 · 另一条线', exact: true }).click();
  await expect(
    content.getByRole('heading', { level: 1, name: '另一条线', exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(400);
  await expect(content.getByRole('heading', { level: 1 })).toHaveText('另一条线');
  await expect(
    explorer.getByRole('button', { name: '定位业务线 · 另一条线', exact: true }),
  ).toHaveAttribute('aria-current', 'location');
  await page.getByLabel('搜索工作', { exact: true }).fill('不存在的名称');
  await expect(content).toContainText('没有匹配的工作');
  await expect(explorer.locator('.workspace-nav-tree button')).toHaveCount(0);
  await page.getByLabel('搜索工作', { exact: true }).fill('');
  await explorer.getByRole('button', { name: '定位业务线 · 论文研究', exact: true }).click();
  await expect(content.getByRole('heading', { level: 1 })).toHaveText('论文研究');
  expect((await snapshot(page)).entries.find((e) => e.data.id === other.data.id)).toBeDefined();
});
