import { test, expect } from '@playwright/test';
import { isComplete } from '../../packages/domain/workspace';
import { connect, seed, write, refresh, snapshot, notes, localDay } from './helpers';

test.beforeEach(async ({ page }) => connect(page));

test('会议快速关联可本次完成，含下属条目；保存前不写入，清空不完成', async ({ page }) => {
  const { project, line, node, todo, idea } = await seed(page);
  const before = await notes(page, line.data.id);
  await page.getByRole('button', { name: '记一段 · 方案会议', exact: true }).click();
  const form = page.getByRole('form', { name: '实际工作录入', exact: true });
  const complete = form.getByRole('checkbox', { name: '本次完成节点 方案会议', exact: true });
  await expect(complete).not.toBeChecked();
  await expect(form).toContainText('含下属 2 个条目');
  await complete.check();
  expect(
    (await snapshot(page)).entries.find((e) => e.data.id === todo.data.id)?.data,
  ).toHaveProperty('completedAt', null);
  await form.getByRole('button', { name: '清空', exact: true }).click();
  await expect(form.getByRole('region', { name: '已选择', exact: true })).toHaveCount(0);
  expect(
    (await snapshot(page)).entries.find((e) => e.data.id === idea.data.id)?.data,
  ).toHaveProperty('completedAt', null);
  await page.getByRole('button', { name: '记一段 · 方案会议', exact: true }).click();
  await complete.check();
  await form.getByLabel('具体事件', { exact: true }).fill('完成方案会议');
  await form.getByLabel('开始时间', { exact: true }).fill('09:00');
  await form.getByLabel('结束时间', { exact: true }).fill('10:00');
  await form.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(form.getByLabel('具体事件', { exact: true })).toHaveValue('');
  const state = await snapshot(page);
  for (const id of [todo.data.id, idea.data.id])
    expect(state.entries.find((e) => e.data.id === id)?.data).toHaveProperty(
      'completedAt',
      expect.any(String),
    );
  const savedNode = state.entries.find((e) => e.data.id === node.data.id)!.data;
  expect(savedNode).toHaveProperty('completedAt', null);
  expect(isComplete(savedNode, state.entries)).toBe(true);
  for (const id of [project.data.id, line.data.id])
    expect(state.entries.find((e) => e.data.id === id)?.data).toHaveProperty('completedAt', null);
  expect(state.entries.filter((e) => e.data.type === 'actual')).toHaveLength(1);
  expect(await notes(page, line.data.id)).toBe(before);
});

test('待添加和已添加独立保留，移除再添加保留批注，子条目随节点选择可还原', async ({ page }) => {
  await seed(page);
  const form = page.getByRole('form', { name: '实际工作录入', exact: true });
  await form.getByText('关联节点或待办（可选）', { exact: true }).click();
  const candidates = form.getByRole('region', { name: '待选池', exact: true });
  const selected = form.getByRole('region', { name: '已选择', exact: true });
  await expect(candidates.getByRole('heading', { name: '待添加', exact: true })).toBeVisible();
  const nodeChoice = candidates
    .locator('.actual-pool-choice')
    .filter({ hasText: '节点 · 方案会议' });
  await nodeChoice.getByRole('button', { name: '加入', exact: true }).click();
  await expect(selected.getByRole('heading', { name: '已添加', exact: true })).toBeVisible();
  await expect(nodeChoice).toHaveCount(0);
  await candidates
    .locator('.actual-pool-choice')
    .filter({ hasText: 'TODO · 找人要材料' })
    .getByRole('button', { name: '加入', exact: true })
    .click();
  await selected.getByText('成果 / 下一步 · 方案会议', { exact: true }).click();
  await selected.getByLabel('批注 · 方案会议', { exact: true }).fill('未保存的会议结论');
  const parent = selected.getByRole('checkbox', { name: '本次完成节点 方案会议', exact: true });
  const child = selected.getByRole('checkbox', { name: '本次完成 找人要材料', exact: true });
  await parent.check();
  await expect(child).toBeChecked();
  await expect(child).toBeDisabled();
  await parent.uncheck();
  await expect(child).toBeEnabled();
  await expect(child).not.toBeChecked();
  await selected
    .locator('.actual-item')
    .filter({ has: page.getByRole('checkbox', { name: '本次完成节点 方案会议', exact: true }) })
    .getByRole('button', { name: '移除', exact: true })
    .click();
  await expect(nodeChoice).toBeVisible();
  await nodeChoice.getByRole('button', { name: '加入', exact: true }).click();
  await selected.getByText('成果 / 下一步 · 方案会议', { exact: true }).click();
  await expect(selected.getByLabel('批注 · 方案会议', { exact: true })).toHaveValue(
    '未保存的会议结论',
  );
  expect((await snapshot(page)).entries.filter((e) => e.data.type === 'actual')).toHaveLength(0);
});

test('无条目会议仅关联时不完成，修改已有实际记录可补选本次完成', async ({ page }) => {
  const { line } = await seed(page);
  const node = await write(page, 'milestone', {
    title: '临时会面',
    lineId: line.data.id,
    dueDate: localDay(),
    dueTime: '15:00',
  });
  await refresh(page);
  await page.getByRole('button', { name: '记一段 · 临时会面', exact: true }).click();
  const form = page.getByRole('form', { name: '实际工作录入', exact: true });
  await expect(
    form.getByRole('checkbox', { name: '本次完成节点 临时会面', exact: true }),
  ).not.toBeChecked();
  await form.getByLabel('具体事件', { exact: true }).fill('临时会面实际记录');
  await form.getByLabel('开始时间', { exact: true }).fill('15:00');
  await form.getByLabel('结束时间', { exact: true }).fill('16:00');
  await form.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(form.getByLabel('具体事件', { exact: true })).toHaveValue('');
  let state = await snapshot(page);
  const actualId = state.entries.find((e) => e.data.type === 'actual')!.data.id;
  expect(state.entries.find((e) => e.data.id === node.data.id)?.data).toHaveProperty(
    'completedAt',
    null,
  );
  await page.getByRole('button', { name: '编辑记录 · 临时会面实际记录', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: '本次完成节点 临时会面', exact: true }).check();
  await dialog.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  state = await snapshot(page);
  expect(state.entries.find((e) => e.data.id === node.data.id)?.data).toHaveProperty(
    'completedAt',
    expect.any(String),
  );
  expect(state.entries.filter((e) => e.data.type === 'actual').map((e) => e.data.id)).toEqual([
    actualId,
  ]);
});
