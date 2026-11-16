import { expect, test, type Page } from '@playwright/test';
import { connect, seed, snapshot, notes, write, refresh, localDay } from './helpers';

const navigate = (page: Page, mobile: boolean, name: string) =>
  page
    .getByRole('navigation', { name: mobile ? '手机导航' : '主导航', exact: true })
    .getByRole('button', { name, exact: true })
    .click();

for (const mobile of [false, true]) {
  test.describe(mobile ? 'Android 快速记录' : 'Windows 快速记录', () => {
    test.beforeEach(async ({ page }) => {
      await connect(page);
    });

    test('选时间格并保存后展示已做，随后在工作空间关联并写入批注', async ({ page }) => {
      const { line, node, todo } = await seed(page);
      await write(page, 'actual', {
        date: localDay(),
        startTime: '18:00',
        endTime: '18:30',
        description: '已有的较晚时段',
      });
      await refresh(page);
      if (mobile) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/?ui=android');
        await navigate(page, true, '编辑');
      }
      const form = page.getByRole('form', { name: '实际工作录入', exact: true });
      const grid = form.getByRole('group', { name: '一天的 48 个半小时' });
      await expect(grid.getByRole('button')).toHaveCount(48);
      await expect(grid.locator('[tabindex="0"]')).toHaveCount(1);
      await grid.getByRole('button', { name: '08:00–08:30', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(grid.getByRole('button', { name: '08:30–09:00', exact: true })).toBeFocused();
      const first = await grid
        .getByRole('button', { name: '08:00–08:30', exact: true })
        .boundingBox();
      const last = await grid
        .getByRole('button', { name: '09:00–09:30', exact: true })
        .boundingBox();
      await page.mouse.move(first!.x + first!.width / 2, first!.y + first!.height / 2);
      await page.mouse.down();
      await page.mouse.move(last!.x + last!.width / 2, last!.y + last!.height / 2, { steps: 5 });
      await page.mouse.up();
      await expect(grid.locator('[aria-pressed="true"]')).toHaveCount(3);
      await expect(form.getByLabel('已选时间', { exact: true })).toHaveText(
        '08:00–09:30 · 90 分钟',
      );
      await expect(form.getByLabel('开始时间', { exact: true })).toHaveCount(0);
      await expect(form.getByLabel('结束时间', { exact: true })).toHaveCount(0);
      await expect(form.getByRole('region', { name: '待选池' })).toHaveCount(0);
      await form.getByLabel('具体事件', { exact: true }).fill('整理实验材料');
      await form.getByRole('button', { name: '保存实际工作', exact: true }).click();
      await expect(
        page.getByRole('button', { name: '编辑记录 · 整理实验材料', exact: true }),
      ).toBeVisible();
      await expect(page.getByText('已保存，记录已添加到下方。', { exact: true })).toBeVisible();
      const actual = (await snapshot(page)).entries.find(
        ({ data }) => data.type === 'actual' && data.description === '整理实验材料',
      )!;
      expect(actual.data).toMatchObject({
        startTime: '08:00',
        endTime: '09:30',
        milestoneIds: [],
        itemIds: [],
      });
      await page.getByRole('button', { name: '关联模式', exact: true }).click();
      const mode = page.getByRole('dialog', { name: '工作空间 · 关联模式', exact: true });
      await expect(mode.getByLabel('实际记录', { exact: true })).toHaveValue(actual.data.id);
      if (mobile)
        await mode.getByRole('button', { name: '打开业务线 论文研究', exact: true }).click();
      await mode.getByRole('checkbox', { name: '关联节点 方案会议', exact: true }).click();
      await mode.getByRole('checkbox', { name: '关联条目 找人要材料', exact: true }).click();
      await mode.getByLabel('批注 · 方案会议', { exact: true }).fill('材料已核对');
      await mode.getByRole('checkbox', { name: '本次完成 找人要材料', exact: true }).check();
      await mode.getByRole('button', { name: '保存关联并返回已做', exact: true }).click();
      await expect(mode).toHaveCount(0);
      expect(
        (await snapshot(page)).entries.find(({ data }) => data.id === actual.data.id)?.data,
      ).toMatchObject({ milestoneIds: [node.data.id], itemIds: [todo.data.id] });
      expect(await notes(page, line.data.id)).toContain('材料已核对');
      await page.screenshot({
        path: `.test-vault/redesign/after-${mobile ? 'mobile' : 'desktop'}-done.png`,
        fullPage: true,
      });
    });

    test('从节点按日期快速关联已有时间段，点击条目直接批注', async ({ page }) => {
      const { line, node, todo } = await seed(page);
      const yesterday = new Date(localDay() + 'T12:00:00');
      yesterday.setDate(yesterday.getDate() - 1);
      const date = localDay(yesterday);
      const actual = await write(page, 'actual', {
        date,
        startTime: '14:00',
        endTime: '15:00',
        description: '昨天整理过材料',
        itemIds: [todo.data.id],
      });
      await refresh(page);
      if (mobile) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/?ui=android');
      }
      await navigate(page, mobile, '工作空间');
      if (mobile)
        await page.getByRole('button', { name: '打开业务线 论文研究', exact: true }).click();
      const point = page
        .locator(`[data-space-id="${node.data.id}"]`)
        .filter({ has: page.locator(mobile ? '.mobile-node-name' : '.point-title') })
        .first();
      if (mobile) {
        await point.locator('.mobile-node-name').dispatchEvent('pointerdown', {
          pointerType: 'touch',
          button: 0,
          clientX: 100,
          clientY: 100,
        });
        await expect(page.getByRole('dialog', { name: '编辑节点', exact: true })).toBeVisible();
        await point
          .locator('.mobile-node-name')
          .dispatchEvent('pointerup', { pointerType: 'touch', clientX: 100, clientY: 100 });
        await page.getByRole('button', { name: '关联做过的事', exact: true }).click();
      } else {
        await point.locator('.point-title').click({ button: 'right' });
        await page.getByRole('menuitem', { name: '关联做过的事', exact: true }).click();
      }
      const matcher = page.getByRole('dialog', { name: '关联做过的事 · 方案会议', exact: true });
      await matcher.getByLabel('做事日期', { exact: true }).fill(date);
      await matcher.getByRole('button', { name: '关联', exact: true }).click();
      await expect(matcher.getByRole('button', { name: '已关联', exact: true })).toBeDisabled();
      expect(
        (await snapshot(page)).entries.find(({ data }) => data.id === actual.data.id)?.data,
      ).toMatchObject({ milestoneIds: [node.data.id], itemIds: [todo.data.id] });
      await matcher.getByRole('button', { name: '关闭对话框', exact: true }).click();
      if (mobile)
        await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
      await page
        .locator(
          `[data-space-id="${todo.data.id}"] ${mobile ? '.mobile-todo-title' : '.todo-title'}`,
        )
        .first()
        .click();
      const body = page.getByLabel('内部正文', { exact: true });
      await expect(body).toBeEnabled();
      await body.fill('点击就能记录的批注');
      await page.getByRole('button', { name: '保存内容', exact: true }).click();
      expect(await notes(page, line.data.id)).toContain('点击就能记录的批注');
      await expect(
        page
          .getByRole('navigation', { name: mobile ? '手机导航' : '主导航', exact: true })
          .getByRole('button', { name: mobile ? '笔记' : '知识', exact: true }),
      ).toHaveCount(0);
    });
  });
}
