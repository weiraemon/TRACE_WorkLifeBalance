import { test, expect } from '@playwright/test';
import { connect, seed, nav, write, refresh, snapshot } from './helpers';

test.beforeEach(async ({ page }) => connect(page));

test('拖动标题排序业务线和待办，跨线移动节点、条目并持久保存', async ({ page }) => {
  const { project, line, node, todo, idea } = await seed(page);
  const second = await write(page, 'workline', { title: '接收业务线', projectId: project.data.id });
  const third = await write(page, 'workline', { title: '第三业务线', projectId: project.data.id });
  await refresh(page);
  await nav(page, '工作空间');
  const board = page.locator('.workspace-content');
  const item = (id: string) => board.locator(`[data-space-id="${id}"]`);
  await item(third.data.id)
    .locator('.line-title')
    .dragTo(item(second.data.id), {
      targetPosition: { x: 30, y: 4 },
    });
  await expect(board.getByRole('status')).toHaveText('已保存移动');
  await expect(board.locator('.line-title')).toHaveText(['论文研究', '第三业务线', '接收业务线']);
  await expect(page.locator('.workspace-nav-tree > ul > li > ul > li button')).toHaveText([
    '论文研究',
    '第三业务线',
    '接收业务线',
  ]);
  await item(idea.data.id)
    .locator('.todo-title')
    .dragTo(item(todo.data.id).locator('.todo-title'), {
      targetPosition: { x: 30, y: 2 },
    });
  await expect(item(node.data.id).locator('.todo-title')).toHaveText([
    'IDEA · 验证替代解释',
    '找人要材料',
  ]);
  await item(node.data.id)
    .locator('.point-title')
    .dragTo(item(second.data.id).locator('.line-title'));
  await expect(item(second.data.id).locator(`[data-space-id="${node.data.id}"]`)).toHaveCount(1);
  const pool = item(line.data.id).locator('.todo-pool');
  await expect(pool.locator('.point-title')).not.toHaveAttribute('draggable');
  await item(todo.data.id).locator('.todo-title').dragTo(pool.locator('.point-title'));
  await expect(pool.locator('.todo-title')).toHaveText(['找人要材料']);
  await expect(board.getByRole('status')).toContainText('已移入待办池');
  await refresh(page);
  await expect(board.locator('.line-title')).toHaveText(['论文研究', '第三业务线', '接收业务线']);
  await expect(item(second.data.id).locator('.todo-title')).toHaveText(['IDEA · 验证替代解释']);
  const records = (await snapshot(page)).entries.map((e) => e.data);
  expect(records.find((r) => r.id === node.data.id)).toMatchObject({ lineId: second.data.id });
  expect(records.find((r) => r.id === idea.data.id)).toMatchObject({
    milestoneId: node.data.id,
    completedAt: null,
  });
});

test('业务线拖进空项目；无效落点和 Esc 取消不保存', async ({ page }) => {
  const { line, todo } = await seed(page);
  const project = await write(page, 'project', { title: '空项目' });
  await refresh(page);
  await nav(page, '工作空间');
  const board = page.locator('.workspace-content');
  const source = board.locator(`[data-space-id="${todo.data.id}"] .todo-title`);
  const destination = board.locator(`[data-space-id="${project.data.id}"]`);
  const before = (await snapshot(page)).entries;
  await source.dragTo(destination.locator('.project-title'));
  expect((await snapshot(page)).entries).toEqual(before);
  const box = await source.boundingBox();
  if (!box) throw new Error('待办不可见');
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + 35, box.y + 20, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(board.locator('[data-dragging], [data-drop-position]')).toHaveCount(0);
  expect((await snapshot(page)).entries).toEqual(before);
  await board
    .locator(`[data-space-id="${line.data.id}"] .line-title`)
    .dragTo(destination.locator('.project-title'));
  await expect(destination.locator('.line-title')).toHaveText(['论文研究']);
  expect(
    (await snapshot(page)).entries.find((e) => e.data.id === line.data.id)?.data,
  ).toMatchObject({ projectId: project.data.id });
});
