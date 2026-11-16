import { test, expect } from '@playwright/test';
import { isComplete } from '../../packages/domain/workspace';
import {
  associationMode,
  connect,
  seed,
  write,
  refresh,
  snapshot,
  notes,
  localDay,
  selectTime,
} from './helpers';

test.beforeEach(async ({ page }) => connect(page));

for (const mobile of [false, true]) {
  test(`${mobile ? 'Android' : 'Windows'} 关联工作空间隐藏已完成候选，保留已有实际关联`, async ({
    page,
  }) => {
    const { line } = await seed(page);
    const completedAt = new Date().toISOString();
    const manual = await write(page, 'milestone', {
      title: '手动完成节点',
      lineId: line.data.id,
      completedAt,
    });
    const derived = await write(page, 'milestone', { title: '推导完成节点', lineId: line.data.id });
    await write(page, 'todo', { title: '已完成子项', milestoneId: derived.data.id, completedAt });
    const actual = await write(page, 'actual', {
      date: localDay(),
      startTime: '09:00',
      endTime: '10:00',
      description: '已有节点关联',
      milestoneIds: [manual.data.id, derived.data.id],
    });
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobile ? '/?ui=android' : '/');
    if (mobile)
      await page
        .getByRole('navigation', { name: '手机导航' })
        .getByRole('button', { name: '今日已做', exact: true })
        .click();
    const mode = await associationMode(page);
    if (mobile)
      await mode.getByRole('button', { name: '打开业务线 论文研究', exact: true }).click();
    for (const title of ['手动完成节点', '推导完成节点']) {
      await expect(
        mode.getByRole('checkbox', { name: `关联节点 ${title}`, exact: true }),
      ).toHaveCount(0);
      await expect(mode.getByRole('region', { name: '已选择', exact: true })).toContainText(title);
    }
    await expect(
      mode.getByRole('checkbox', { name: '关联节点 方案会议', exact: true }),
    ).toBeVisible();
    await mode.getByRole('button', { name: '保存关联并返回已做', exact: true }).click();
    await expect(mode).toHaveCount(0);
    expect(
      (await snapshot(page)).entries.find((entry) => entry.data.id === actual.data.id)?.data,
    ).toMatchObject({ milestoneIds: [manual.data.id, derived.data.id] });
  });
}

test('记一段先保存实际，关联模式本次完成节点包含下属条目，清空不完成', async ({ page }) => {
  const { project, line, node, todo, idea } = await seed(page);
  const before = await notes(page, line.data.id);
  await page.getByRole('button', { name: '记一段 · 方案会议', exact: true }).click();
  const form = page.getByRole('form', { name: '实际工作录入', exact: true });
  await form.getByRole('button', { name: '清空', exact: true }).click();
  expect(
    (await snapshot(page)).entries.find((entry) => entry.data.id === idea.data.id)?.data,
  ).toHaveProperty('completedAt', null);
  await page.getByRole('button', { name: '记一段 · 方案会议', exact: true }).click();
  await form.getByLabel('具体事件', { exact: true }).fill('完成方案会议');
  await selectTime(form, '09:00', '10:00');
  await form.getByRole('button', { name: '保存实际工作', exact: true }).click();
  const mode = await associationMode(page);
  const complete = mode.getByRole('checkbox', { name: '本次完成节点 方案会议', exact: true });
  await expect(complete).not.toBeChecked();
  await expect(mode).toContainText('含下属 2 个条目');
  await complete.check();
  expect(
    (await snapshot(page)).entries.find((entry) => entry.data.id === todo.data.id)?.data,
  ).toHaveProperty('completedAt', null);
  await mode.getByRole('button', { name: '保存关联并返回已做', exact: true }).click();
  await expect(mode).toHaveCount(0);
  const state = await snapshot(page);
  for (const id of [todo.data.id, idea.data.id])
    expect(state.entries.find((entry) => entry.data.id === id)?.data).toHaveProperty(
      'completedAt',
      expect.any(String),
    );
  expect(
    isComplete(state.entries.find((entry) => entry.data.id === node.data.id)!.data, state.entries),
  ).toBe(true);
  for (const id of [project.data.id, line.data.id])
    expect(state.entries.find((entry) => entry.data.id === id)?.data).toHaveProperty(
      'completedAt',
      null,
    );
  expect(await notes(page, line.data.id)).toBe(before);
});

test('勾选与已添加独立，移除再添加保留批注，子条目随节点选择可还原', async ({ page }) => {
  await seed(page);
  await write(page, 'actual', {
    date: localDay(),
    startTime: '09:00',
    endTime: '10:00',
    description: '待关联的记录',
  });
  await refresh(page);
  const mode = await associationMode(page);
  await mode.getByRole('checkbox', { name: '关联节点 方案会议', exact: true }).click();
  await mode.getByRole('checkbox', { name: '关联条目 找人要材料', exact: true }).click();
  const selected = mode.getByRole('region', { name: '已选择', exact: true });
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
  await mode.getByRole('checkbox', { name: '关联节点 方案会议', exact: true }).click();
  await expect(selected.getByLabel('批注 · 方案会议', { exact: true })).toHaveValue(
    '未保存的会议结论',
  );
  await mode.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '编辑记录 · 待关联的记录', exact: true }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('具体事件', { exact: true }).fill('只修改事件正文');
  await editor.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(
    (await snapshot(page)).entries.find((entry) => entry.data.type === 'actual')?.data,
  ).toMatchObject({ milestoneIds: [], itemIds: [] });
  expect(
    (await snapshot(page)).entries.filter((entry) => entry.data.type === 'actual'),
  ).toHaveLength(1);
});

test('无条目会议仅关联时不完成，已有实际记录可在关联模式补选完成', async ({ page }) => {
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
  await form.getByLabel('具体事件', { exact: true }).fill('临时会面实际记录');
  await selectTime(form, '15:00', '16:00');
  await form.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(page.getByRole('button', { name: '关联模式', exact: true })).toBeVisible();
  const state = await snapshot(page);
  const actualId = state.entries.find((entry) => entry.data.type === 'actual')!.data.id;
  expect(state.entries.find((entry) => entry.data.id === node.data.id)?.data).toHaveProperty(
    'completedAt',
    null,
  );
  const mode = await associationMode(page);
  await mode.getByRole('checkbox', { name: '本次完成节点 临时会面', exact: true }).check();
  await mode.getByRole('button', { name: '保存关联并返回已做', exact: true }).click();
  await expect(mode).toHaveCount(0);
  const saved = await snapshot(page);
  expect(saved.entries.find((entry) => entry.data.id === node.data.id)?.data).toHaveProperty(
    'completedAt',
    expect.any(String),
  );
  expect(
    saved.entries.filter((entry) => entry.data.type === 'actual').map((entry) => entry.data.id),
  ).toEqual([actualId]);
});
