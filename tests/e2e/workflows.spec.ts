import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeNote } from '../../apps/local-service/src/vault';
import { localDay, parseRecord, type RecordData } from '../../packages/domain/index';
let root: string;
const day = localDay();
const shifted = (days: number) => {
  const d = new Date(day + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return localDay(d);
};
test.beforeEach(async ({ page }) => {
  await fs.mkdir('.test-vault', { recursive: true });
  root = await fs.mkdtemp(path.resolve('.test-vault/space-'));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: /从这里，继续今天。|从你的 Obsidian Vault 开始/ }),
  ).toBeVisible();
  if (await page.getByRole('button', { name: 'Vault 与备份' }).count())
    await page.getByRole('button', { name: 'Vault 与备份' }).click();
  await page.getByLabel('Vault 绝对路径').fill(root);
  await page.getByRole('button', { name: '连接本地 Vault', exact: true }).click();
  await expect(page.getByRole('heading', { name: '从这里，继续今天。' })).toBeVisible();
});
const nav = async (page: Page, name: string) =>
  page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
const refresh = async (page: Page) => {
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/snapshot')),
    page.getByRole('button', { name: '重新加载 Vault' }).click(),
  ]);
  await expect(page.getByRole('button', { name: '重新加载 Vault' })).toBeEnabled();
};
const saveForm = async (page: Page) => {
  await page.getByRole('button', { name: '保存到 Vault', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
};
async function write(page: Page, type: RecordData['type'], fields: object) {
  const s = await page.request.get('/api/session').then((r) => r.json());
  const now = new Date().toISOString();
  const data = parseRecord({
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    type,
    ...fields,
  });
  const result = await page.request.post('/api/records', {
    headers: { 'X-Atlas-Token': s.token, 'X-Atlas-Vault': s.vaultId },
    data: { data },
  });
  expect(result.ok(), await result.text()).toBe(true);
  return (await result.json()).data as RecordData;
}
async function seed(page: Page) {
  const project = await write(page, 'project', { title: '项目 A' });
  const line = await write(page, 'workline', {
    title: '阶段报告',
    projectId: project.id,
    kind: 'report',
  });
  const point = await write(page, 'milestone', {
    title: '指标审阅',
    lineId: line.id,

    dueDate: day,
    dueTime: '09:00',
    kind: 'review',
  });
  const todo = await write(page, 'todo', {
    title: '核对指标',
    milestoneId: point.id,
    importance: 5,
    estimatedMinutes: 30,
  });
  await refresh(page);
  return { project, line, point, todo };
}
async function files() {
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const child of await fs.readdir(dir, { withFileTypes: true })) {
      if (child.name.startsWith('.')) continue;
      const p = path.join(dir, child.name);
      if (child.isDirectory()) out.push(...(await walk(p)));
      else if (child.name.endsWith('.md')) out.push(p);
    }
    return out;
  };
  const out = [];
  for (const p of await walk(root)) {
    const raw = await fs.readFile(p, 'utf8');
    const note = decodeNote(raw);
    if (note) out.push({ data: note.data, path: p, raw });
  }
  return out;
}
async function actual(page: Page, start = '09:03', end = '09:37', description = '实际核对指标') {
  await nav(page, '今日');
  await page.getByRole('button', { name: '记录实际', exact: true }).click();
  await page.getByLabel('开始时间', { exact: true }).fill(start);
  await page.getByLabel('结束时间', { exact: true }).fill(end);
  await page.getByLabel('具体事件').fill(description);
}
const saveActual = async (page: Page) => {
  await page.getByRole('button', { name: '保存实际工作', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
};

test('A 四层空间：最少输入、上下文归属、节点颜色、日期、重要性与项目收缩', async ({ page }) => {
  await nav(page, '工作空间');
  await page.getByRole('button', { name: '新增项目', exact: true }).click();
  expect(await page.getByRole('dialog').locator('input:visible').count()).toBe(1);
  await page.getByLabel('标题', { exact: true }).fill('项目 A');
  await saveForm(page);
  const plane = page.getByRole('region', { name: '项目面 · 项目 A' });
  await plane.getByRole('button', { name: '业务线', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('阶段报告');
  await saveForm(page);
  const track = page.getByRole('region', { name: '业务线 · 阶段报告' });
  await track.getByRole('button', { name: '关键节点', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('V2 审阅');

  await page.getByLabel('截止日期', { exact: true }).fill(day);
  await page.getByText('可选设置', { exact: true }).click();
  await page.getByLabel('节点类型', { exact: true }).selectOption('review');
  await page.getByRole('button', { name: '重要性：较急', exact: true }).click();
  await saveForm(page);
  const point = page.getByRole('article', { name: '关键节点 · V2 审阅' });
  await expect(point.locator('.point-dot')).toHaveClass(/priority-4/);
  await expect(point).toHaveCSS('border-top-width', '0px');
  await point.getByRole('button', { name: '待办', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('检查图表');
  await expect(page.getByLabel('截止日期', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '重要性：很急', exact: true }).click();
  await saveForm(page);
  await expect(point.getByText('检查图表', { exact: true })).toBeVisible();
  await plane.getByRole('button', { name: '收缩项目 项目 A' }).click();
  await expect(track).toHaveCount(0);
  await plane.getByRole('button', { name: '展开项目 项目 A' }).click();
  await expect(track).toBeVisible();
  const stored = await files();
  const p = stored.find((r) => r.data.type === 'project')!.data;
  const l = stored.find((r) => r.data.type === 'workline')!.data;
  const m = stored.find((r) => r.data.type === 'milestone')!.data;
  const t = stored.find((r) => r.data.type === 'todo')!.data;
  expect(l).toMatchObject({ projectId: p.id });
  expect(m).toMatchObject({ lineId: l.id });
  expect(t).toMatchObject({ milestoneId: m.id, importance: 5 });
  expect(t).not.toHaveProperty('dueDate');
  expect(t).not.toHaveProperty('projectId');
});
test('B 今日仅实际入口，三个必填内容，完成联动与撤回均真实落盘', async ({ page }) => {
  const { todo } = await seed(page);
  await expect(page.getByRole('button', { name: /新增项目|新增待办|＋计划/ })).toHaveCount(0);
  await actual(page);
  expect(await page.getByRole('dialog').locator('[required]:visible').count()).toBe(3);
  await expect(page.getByLabel('记录类型')).toHaveCount(0);
  await page.getByText('关联待办（可选）', { exact: false }).click();
  await page.getByRole('checkbox', { name: '关联 核对指标', exact: true }).check();
  await page.getByRole('checkbox', { name: '本次完成 核对指标', exact: true }).check();
  await saveActual(page);
  await expect(page.locator('.today-todos').getByText('核对指标', { exact: true })).toHaveCount(0);
  let data = await files();
  expect(data.find((r) => r.data.type === 'actual')?.data).toMatchObject({
    startTime: '09:03',
    endTime: '09:37',
    completedTodoIds: [todo.id],
  });
  expect(data.find((r) => r.data.id === todo.id)?.data).toMatchObject({ status: 'Ready' });
  const event = page.locator('.calendar-side.actual .fc-event');
  await event.click();
  await page.getByRole('checkbox', { name: '关联 核对指标', exact: true }).uncheck();
  await saveActual(page);
  await expect(page.locator('.today-todos').getByText('核对指标', { exact: true })).toBeVisible();
  data = await files();
  expect(data.find((r) => r.data.type === 'actual')?.data).toMatchObject({
    completedTodoIds: [],
  });
});
test('C 自己 / To / From、联系人汇总、当天过滤与可解释的优先顺序', async ({ page }) => {
  const { line, point } = await seed(page);
  await write(page, 'todo', {
    title: '短而重要',
    milestoneId: point.id,
    importance: 5,
    estimatedMinutes: 10,
  });
  await write(page, 'todo', {
    title: '等待实验图',
    milestoneId: point.id,
    direction: 'from',
    person: '小王',
    status: 'Waiting',
    importance: 5,
  });
  await write(page, 'todo', {
    title: '发送修改要求',
    milestoneId: point.id,
    direction: 'to',
    person: '小王',
    importance: 4,
  });
  const future = await write(page, 'milestone', {
    title: '明天审阅',
    lineId: line.id,
    dueDate: shifted(1),
  });
  await write(page, 'todo', { title: '明天再做', milestoneId: future.id, importance: 5 });
  await refresh(page);
  await expect(page.locator('.today-todos').getByText('明天再做')).toHaveCount(0);
  await expect(page.locator('.today-todos li').first()).toContainText('短而重要');
  await expect(page.getByRole('heading', { name: '先做什么', exact: true })).toHaveCount(0);
  const contact = page.locator('.contact-agenda');
  await expect(contact.locator('.contact-person')).toHaveText(['等 小王', '找 小王']);
  await expect(contact).toContainText('等待实验图');
  await expect(contact).toContainText('发送修改要求');
  await expect(page.locator('.today-todos')).not.toContainText(/To|From/);
  await nav(page, '工作空间');
  await page
    .getByRole('article', { name: '关键节点 · 指标审阅' })
    .getByRole('button', { name: '待办', exact: true })
    .click();
  await page.getByLabel('标题', { exact: true }).fill('再等一份材料');
  await page.getByRole('button', { name: '等待他人 · From', exact: true }).click();
  await page.getByLabel('联系人', { exact: true }).fill('小李');
  await saveForm(page);
  expect(
    (await files()).find((r) => 'title' in r.data && r.data.title === '再等一份材料')?.data,
  ).toMatchObject({ direction: 'from', person: '小李', status: 'Waiting' });
});
test('D 仅节点维护日期，日期调整后当天清单更新', async ({ page }) => {
  await seed(page);
  await nav(page, '工作空间');
  await page.locator('.point-dates').click();

  await page.getByLabel('截止日期', { exact: true }).fill(shifted(1));
  await saveForm(page);
  await nav(page, '今日');
  await expect(page.locator('.today-todos')).toHaveCount(0);
  await page.getByLabel('查看日期').fill(shifted(1));
  await expect(page.locator('.today-todos')).toContainText('核对指标');
});
test('E 外部冲突、移动到根目录、正文无损、备份恢复', async ({ page }) => {
  await seed(page);
  await nav(page, '工作空间');
  await page.getByRole('button', { name: '编辑项目 项目 A' }).click();
  await page.getByLabel('标题', { exact: true }).fill('未保存改动');
  const first = (await files()).find((r) => r.data.type === 'project')!;
  await fs.writeFile(
    first.path,
    first.raw.replace('atlas:', 'tags: [保留]\natlas:') + '\n外部编辑的正文\n',
  );
  await page.getByRole('button', { name: '保存到 Vault', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('更改');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await fs.rename(first.path, path.join(root, '移动的项目.md'));
  await refresh(page);
  await page.getByRole('button', { name: '编辑项目 项目 A' }).click();
  await page.getByLabel('标题', { exact: true }).fill('项目 A 新标题');
  await saveForm(page);
  const raw = await fs.readFile(path.join(root, '移动的项目.md'), 'utf8');
  expect(raw).toContain('tags: [保留]');
  expect(raw).toContain('外部编辑的正文');
  await page.getByRole('button', { name: 'Vault 与备份' }).click();
  await page.getByRole('button', { name: '创建管理数据快照' }).click();
  await expect(page.getByRole('status')).toContainText('已备份 4');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '恢复', exact: true }).first().click();
  await expect(page.getByRole('status')).toContainText('已恢复 4');
});
test('F 未授权请求与实际重叠被拒绝，窄屏快捷键统一去今日', async ({ page, request }) => {
  expect((await request.get('/api/snapshot')).status()).toBe(403);
  const s = await request.get('/api/session').then((r) => r.json());
  expect(
    (
      await request.post('/api/backup', {
        headers: { Origin: 'https://evil.example', 'X-Atlas-Token': s.token },
        data: {},
      })
    ).status(),
  ).toBe(403);
  await actual(page, '09:00', '10:00', '第一段实际');
  await saveActual(page);
  await actual(page, '09:30', '10:30', '重叠实际');
  await page.getByRole('button', { name: '保存实际工作' }).click();
  await expect(page.getByRole('alert')).toContainText('重叠');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await nav(page, '工作空间');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toContainText('记录实际工作');
  await page.getByLabel('具体事件').fill('午后散步');
  await page.getByLabel('开始时间', { exact: true }).fill('18:00');
  await page.getByLabel('结束时间', { exact: true }).fill('18:30');
  await saveActual(page);
  await expect(page.getByRole('heading', { name: '从这里，继续今天。' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('G 实际时间线真实拖动、拉伸、历史与刻度对齐', async ({ page }) => {
  await actual(page, '09:00', '10:00', '拖动验证');
  await saveActual(page);
  const event = page.locator('.calendar-side.actual .fc-event');
  await event.scrollIntoViewIfNeeded();
  let box = (await event.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 15);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.move(box.x + box.width / 2, box.y + 87, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => (await files()).find((r) => r.data.type === 'actual')?.data)
    .toMatchObject({ startTime: '10:00' });
  await event.hover();
  box = (await event.locator('.fc-event-resizer-end').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 36, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => (await files()).find((r) => r.data.type === 'actual')?.data)
    .toMatchObject({ endTime: '11:30', history: expect.any(Array) });
  expect(
    (await files()).find((r) => r.data.type === 'actual')?.data.type === 'actual' &&
      (await files()).find((r) => r.data.type === 'actual')!.data,
  ).toMatchObject({
    history: expect.arrayContaining([expect.objectContaining({ startTime: '09:00' })]),
  });
  const slot = (await page
    .locator('.calendar-side.actual .fc-timegrid-slot-lane[data-time="09:00:00"]')
    .boundingBox())!;
  const ruler = (await page.locator('.shared-scale time').nth(9).boundingBox())!;
  expect(Math.abs(slot.y - ruler.y - ruler.height / 2)).toBeLessThan(2);
});
test('H 新示例的空间、今日与窄屏视觉验收', async ({ page }) => {
  await fs.cp(path.resolve('examples/workspace-vault'), root, {
    recursive: true,
    filter: (p) => path.basename(p) !== '.atlas',
  });
  await refresh(page);
  const point = (await files()).find(
    (r) => r.data.type === 'milestone' && r.data.title === '指标讨论',
  )!.data;
  if (point.type !== 'milestone') throw new Error();
  await page.getByLabel('查看日期').fill(point.dueDate!);
  await fs.mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/today.png', fullPage: true });
  await nav(page, '工作空间');
  await expect(page.locator('.project-plane')).toHaveCount(2);
  await page.screenshot({ path: 'docs/screenshots/workspace.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'docs/screenshots/mobile-workspace.png', fullPage: true });
  await nav(page, '今日');
  await page.screenshot({ path: 'docs/screenshots/mobile.png', fullPage: true });
});
test('I 资源关联与跨项目移动只修改直接上级，实际归属同步推导', async ({ page }) => {
  const { line, todo } = await seed(page);
  const other = await write(page, 'project', { title: '项目 B' });
  await nav(page, '知识');
  await page.getByRole('button', { name: '关联资源', exact: true }).click();
  await page.getByLabel('资源名称').fill('报告目录');
  await page.getByLabel('路径 / URL').fill('ATLAS');
  await saveForm(page);
  await actual(page, '09:00', '09:30', '核对完成');
  await page.getByText('关联待办（可选）', { exact: false }).click();
  await page.getByRole('checkbox', { name: '关联 核对指标', exact: true }).check();
  await page.getByRole('checkbox', { name: '本次完成 核对指标', exact: true }).check();
  await saveActual(page);
  await nav(page, '工作空间');
  await page.getByRole('button', { name: '阶段报告 报告', exact: true }).click();
  await page
    .getByRole('complementary', { name: '工作详情' })
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  await page.getByText(/更换归属/).click();
  await page.getByLabel('所属项目', { exact: true }).selectOption(other.id);
  await page.getByText('可选设置', { exact: true }).click();
  await page.getByRole('checkbox', { name: '报告目录' }).check();
  await saveForm(page);
  const stored = await files();
  expect(stored.find((r) => r.data.id === line.id)?.data).toMatchObject({
    projectId: other.id,
    resourceIds: [stored.find((r) => r.data.type === 'resource')!.data.id],
  });
  expect(stored.find((r) => r.data.id === todo.id)?.data).not.toHaveProperty('projectId');
  await nav(page, '回顾');
  await expect(page.locator('.totals dt')).toHaveText('项目 B');
  await expect(page.locator('.totals dd')).toHaveText('0.50 h');
});

test('J 其他窗口切换 Vault 后旧表单停止保存并保留输入', async ({ page, request }) => {
  await seed(page);
  await nav(page, '工作空间');
  await page.getByRole('button', { name: '新增项目', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('旧窗口未保存项目');
  const s = await request.get('/api/session').then((r) => r.json());
  const other = await fs.mkdtemp(path.resolve('.test-vault/另一个仓库-'));
  expect(
    (
      await request.post('/api/connect', {
        headers: { 'X-Atlas-Token': s.token },
        data: { path: other },
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole('button', { name: '保存到 Vault', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('切换 Vault');
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue('旧窗口未保存项目');
  expect(await fs.readdir(other)).toEqual(['.atlas']);
  expect((await files()).filter((r) => r.data.type === 'project')).toHaveLength(1);
});
test('K 只接受七种新数据类型，旧类型和旧字段拒绝写入，无兼容入口', async ({ page }) => {
  const s = await page.request.get('/api/session').then((r) => r.json());
  const now = new Date().toISOString();
  for (const type of [
    'node',
    'timeblock',
    'event',
    'iteration',
    'commitment',
    'dependency',
    'gate',
  ]) {
    const response = await page.request.post('/api/records', {
      headers: { 'X-Atlas-Token': s.token, 'X-Atlas-Vault': s.vaultId },
      data: {
        data: {
          schemaVersion: 1,
          id: randomUUID(),
          createdAt: now,
          updatedAt: now,
          type,
          title: '已删除类型',
        },
      },
    });
    expect(response.status()).toBe(400);
  }
  expect(await files()).toHaveLength(0);
  await nav(page, '工作空间');
  await expect(page.getByRole('button', { name: '原有记录', exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('button')).toHaveText([
    '今日',
    '工作空间',
    '知识',
    '回顾',
  ]);
});

test('L 实际按新项目统计，回顾只读实际，周复盘真实落盘', async ({ page }) => {
  const { todo } = await seed(page);
  await actual(page, '09:00', '09:30', '完成指标核对');
  await page.getByText('关联待办（可选）', { exact: false }).click();
  await page.getByRole('checkbox', { name: '关联 核对指标', exact: true }).check();
  await page.getByRole('checkbox', { name: '本次完成 核对指标', exact: true }).check();
  await saveActual(page);
  await nav(page, '回顾');
  await expect(page.locator('.totals dt')).toHaveText('项目 A');
  await expect(page.locator('.totals dd')).toHaveText('0.50 h');
  await page.getByRole('button', { name: '写周复盘' }).click();
  await page.getByText('再多写一点（可选）', { exact: true }).click();
  await page.getByLabel('本周主线', { exact: true }).fill('保持科研主线');
  await page.getByLabel('本周进展').fill('指标核对已完成');
  await page.getByLabel('体会与问题').fill('减少重复记录');
  await page.getByLabel('下周继续什么').fill('继续推进下一节点');
  await saveForm(page);
  expect((await files()).find((r) => r.data.type === 'review')?.data).toMatchObject({
    nextWeek: '继续推进下一节点',
  });
  expect((await files()).find((r) => r.data.type === 'actual')?.data).toMatchObject({
    completedTodoIds: [todo.id],
  });
});

test('M 五档纯色、无框节点、圆圈完成保留划线，以及新增和改期自动排序', async ({ page }) => {
  const { line, todo } = await seed(page);
  await nav(page, '工作空间');
  const original = page.getByRole('article', { name: '关键节点 · 指标审阅' });
  const circle = original.getByRole('checkbox', { name: '完成 核对指标' });
  await expect(circle).toHaveCSS('border-radius', '50%');
  await circle.click();
  await expect(circle).toBeChecked();
  await expect(original.getByRole('button', { name: '核对指标', exact: true })).toHaveCSS(
    'text-decoration-line',
    'line-through',
  );
  expect((await files()).find((r) => r.data.id === todo.id)?.data).toMatchObject({
    status: 'Done',
  });
  await refresh(page);
  await expect(circle).toBeChecked();
  await circle.click();
  await expect(circle).not.toBeChecked();
  expect((await files()).find((r) => r.data.id === todo.id)?.data).toMatchObject({
    status: 'Ready',
  });

  await original.getByRole('button', { name: '调整日期 · 指标审阅' }).click();
  const palette = page.getByRole('group', { name: '重要性', exact: true });
  const swatches = palette.getByRole('button');
  await expect(swatches).toHaveCount(5);
  expect(
    new Set(
      await swatches.evaluateAll((elements) =>
        elements.map((el) => getComputedStyle(el).backgroundColor),
      ),
    ).size,
  ).toBe(5);
  await expect(palette).toHaveText('');
  await palette.getByRole('button', { name: '重要性：很急', exact: true }).click();
  await saveForm(page);
  await expect(original.locator('.point-dot')).toHaveCSS('background-color', 'rgb(212, 58, 58)');
  await expect(original).toHaveCSS('border-top-width', '0px');
  await expect(page.locator('main')).not.toContainText(/[1-5]\/5/);

  await write(page, 'milestone', { title: '未定日期', lineId: line.id, order: -100 });
  const track = page.getByRole('region', { name: '业务线 · 阶段报告' });
  for (const [title, end] of [
    ['后天节点', shifted(3)],
    ['提前节点', shifted(-1)],
  ]) {
    await track.getByRole('button', { name: '关键节点', exact: true }).click();
    await page.getByLabel('标题', { exact: true }).fill(title);

    await page.getByLabel('截止日期', { exact: true }).fill(end);
    await page.getByText('可选设置', { exact: true }).click();
    await expect(page.getByLabel('排列顺序', { exact: true })).toHaveCount(0);
    await saveForm(page);
  }
  await expect(track.locator('.point-title')).toHaveText([
    '提前节点',
    '指标审阅',
    '后天节点',
    '未定日期',
  ]);
  await track.getByRole('button', { name: '调整日期 · 提前节点' }).click();

  await page.getByLabel('截止日期', { exact: true }).fill(shifted(5));
  await saveForm(page);
  await refresh(page);
  await expect(track.locator('.point-title')).toHaveText([
    '指标审阅',
    '后天节点',
    '提前节点',
    '未定日期',
  ]);
  const dot = (await original.locator('.point-dot').boundingBox())!;
  const dates = (await original.locator('.point-dates').boundingBox())!;
  const list = (await original.locator('.todo-rows').boundingBox())!;
  expect(dates.y + dates.height).toBeLessThanOrEqual(dot.y);
  expect(list.y).toBeGreaterThan(dot.y + dot.height);
});

test('N 今日左右均分、单行归属、联络动词，以及仅从工作空间读取的计划线', async ({ page }) => {
  const { point } = await seed(page);
  await write(page, 'todo', {
    title: '等待对方数据',
    milestoneId: point.id,
    importance: 5,
    direction: 'from',
    person: '小王',
    status: 'Waiting',
  });
  await write(page, 'todo', {
    title: '确认交付',
    milestoneId: point.id,
    importance: 4,
    direction: 'to',
    person: '小王',
  });
  await refresh(page);
  const timeline = (await page.locator('.today-timeline').boundingBox())!;
  const lists = (await page.locator('.today-lists').boundingBox())!;
  expect(Math.abs(timeline.width - lists.width)).toBeLessThan(2);
  expect(timeline.x + timeline.width).toBeLessThan(lists.x);
  const todo = (await page.locator('.today-work').boundingBox())!;
  const contacts = (await page.locator('.contact-agenda').boundingBox())!;
  expect(todo.y + todo.height).toBeLessThan(contacts.y);
  await expect(page.locator('.today-work')).toHaveCSS('border-width', '0px');
  await expect(page.locator('.today-todos .row-context').first()).toHaveText('项目 A / 指标审阅');
  await expect(page.locator('.today-todos .row-context').first()).toHaveCSS('text-align', 'right');
  await expect(page.locator('.today-todos .today-task').first()).toHaveCSS('white-space', 'nowrap');
  await expect(page.locator('.today-todos')).not.toContainText(/阶段报告|To|From/);
  await expect(page.locator('.contact-person')).toHaveText(['等 小王', '找 小王']);
  await expect(page.locator('.contact-person').first()).toHaveCSS('font-weight', '600');
  await expect(page.locator('.contact-person').first()).toHaveCSS('font-size', '16px');
  const plan = page.locator('.plan-side');
  await expect(plan.locator('.plan-node-toggle')).toContainText('指标审阅');
  await expect(plan.locator('input,textarea,select')).toHaveCount(0);
  await plan.locator('.fc-timegrid-slot-lane[data-time="10:00:00"]').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const planBox = (await plan.boundingBox())!;
  const actualBox = (await page.locator('.calendar-side.actual').boundingBox())!;
  expect(planBox.x + planBox.width).toBeLessThan(actualBox.x);
  await expect(page.locator('.calendar-side.actual .fc-timegrid-slot-lane')).toHaveCount(96);
  expect(
    (await files()).every((r) =>
      ['project', 'workline', 'milestone', 'todo', 'actual', 'resource', 'review'].includes(
        r.data.type,
      ),
    ),
  ).toBe(true);
  await plan.locator('.plan-node-toggle').click();
  await plan.getByRole('button', { name: '查看节点 ↗', exact: true }).click();
  await expect(page.getByRole('heading', { name: '工作空间', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '调整日期 · 指标审阅' }).click();

  await page.getByLabel('截止日期', { exact: true }).fill(shifted(1));
  await saveForm(page);
  await nav(page, '今日');
  await expect(page.locator('.plan-side .plan-node-toggle')).toHaveCount(0);
  await page.getByLabel('查看日期').fill(shifted(1));
  await expect(page.locator('.plan-side .plan-node-toggle')).toContainText('指标审阅');
});

test('O 节点时刻落盘、计划实际同刻度定位、左侧展开待办与未定时间区', async ({ page }) => {
  const { line, point, todo } = await seed(page);
  await nav(page, '工作空间');
  await page.getByRole('button', { name: '调整日期 · 指标审阅' }).click();
  await page.getByLabel('截止时刻（可选）', { exact: true }).fill('10:15');
  await saveForm(page);
  expect((await files()).find((r) => r.data.id === point.id)?.data).toMatchObject({
    dueTime: '10:15',
  });
  await actual(page, '10:15', '11:00', '同刻度验证');
  await saveActual(page);
  const toggle = page.getByRole('button', { name: '展开节点待办 · 指标审阅', exact: true });
  await toggle.scrollIntoViewIfNeeded();
  const dot = (await toggle.locator('.importance-dot').boundingBox())!;
  const actualSlot = (await page
    .locator('.calendar-side.actual .fc-timegrid-slot-lane[data-time="10:15:00"]')
    .boundingBox())!;
  expect(Math.abs(dot.y + dot.height / 2 - actualSlot.y)).toBeLessThan(3);
  await toggle.click();
  const todos = page.getByLabel('指标审阅的待办', { exact: true });
  await expect(todos).toContainText('核对指标');
  await expect(todos.getByRole('checkbox', { name: '完成 核对指标' })).toBeDisabled();
  const todoBox = (await todos.boundingBox())!;
  const nodeBox = (await page
    .getByRole('button', { name: '收起节点待办 · 指标审阅', exact: true })
    .boundingBox())!;
  expect(todoBox.x + todoBox.width).toBeLessThan(nodeBox.x);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.calendar-side.planned .fc-event-resizer')).toHaveCount(0);
  await page.screenshot({ path: 'docs/screenshots/timed-plans.png', fullPage: true });
  await write(page, 'milestone', { title: '待约时间', lineId: line.id, dueDate: day });
  await write(page, 'milestone', {
    title: '同时讨论',
    lineId: line.id,

    dueDate: day,
    dueTime: '10:15',
  });
  await refresh(page);
  await expect(page.locator('.calendar-side.planned .fc-event')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: '展开节点待办 · 同时讨论', exact: true }),
  ).toBeVisible();
  await page.locator('.unscheduled-plans summary').click();
  await expect(page.locator('.unscheduled-plans')).toContainText('待约时间');
  expect((await files()).find((r) => r.data.id === todo.id)?.data).not.toHaveProperty('startTime');
});

test('P 一个实际区块关联多个待办，同一待办可分段推进，完成关联单独保存', async ({ page }) => {
  const { point, todo } = await seed(page);
  const other = await write(page, 'todo', { title: '整理图稿', milestoneId: point.id });
  await refresh(page);
  await actual(page, '09:00', '10:00', '同时推进指标与图稿');
  await page.getByText('关联待办（可选）', { exact: false }).click();
  await page.getByRole('checkbox', { name: '关联 核对指标', exact: true }).check();
  await page.getByRole('checkbox', { name: '关联 整理图稿', exact: true }).check();
  await saveActual(page);
  let stored = await files();
  const first = stored.find((r) => r.data.type === 'actual')!.data;
  expect(first).toMatchObject({
    workedTodoIds: expect.arrayContaining([todo.id, other.id]),
    completedTodoIds: [],
  });
  expect(stored.find((r) => r.data.id === todo.id)?.data).toMatchObject({ status: 'Ready' });
  const event = page
    .locator('.calendar-side.actual .fc-event')
    .filter({ hasText: '同时推进指标与图稿' });
  await expect(event).toContainText('核对指标');
  await expect(event).toContainText('整理图稿');
  await page.screenshot({ path: 'docs/screenshots/linked-actuals.png', fullPage: true });
  await actual(page, '10:00', '10:30', '继续核对指标');
  await page.getByText('关联待办（可选）', { exact: false }).click();
  await page.getByRole('checkbox', { name: '关联 核对指标', exact: true }).check();
  await page.getByRole('checkbox', { name: '本次完成 核对指标', exact: true }).check();
  await saveActual(page);
  await refresh(page);
  await expect(page.locator('.calendar-side.actual .fc-event')).toHaveCount(2);
  await expect(page.locator('.today-todos')).not.toContainText('核对指标');
  stored = await files();
  expect(
    stored.find((r) => r.data.type === 'actual' && r.data.description === '继续核对指标')?.data,
  ).toMatchObject({ completedTodoIds: [todo.id], workedTodoIds: [] });
  expect(stored.find((r) => r.data.id === todo.id)?.data).toMatchObject({ status: 'Ready' });
  await event.click();
  await expect(page.getByRole('checkbox', { name: '关联 整理图稿', exact: true })).toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: '本次完成 核对指标', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();
});

test('Q 有计划与实际事件时切换到空 Vault，旧日历事件退场不使页面崩溃', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await seed(page);
  await actual(page, '09:00', '09:30', '切换前实际');
  await saveActual(page);
  await expect(page.locator('.calendar-side.planned .fc-event')).toHaveCount(1);
  await expect(page.locator('.calendar-side.actual .fc-event')).toHaveCount(1);
  const empty = await fs.mkdtemp(path.resolve('.test-vault/empty-'));
  await page.getByRole('button', { name: 'Vault 与备份', exact: true }).click();
  await page.getByLabel('Vault 绝对路径').fill(empty);
  await page.getByRole('button', { name: '连接本地 Vault', exact: true }).click();
  await expect(page.getByRole('heading', { name: '从这里，继续今天。' })).toBeVisible();
  await expect(page.locator('.fc-event')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(await files()).toHaveLength(5);
});
