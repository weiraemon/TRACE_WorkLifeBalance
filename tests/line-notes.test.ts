import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vault, hash } from '../apps/local-service/src/vault';
import {
  parseRecord,
  type Entry,
  type BusinessLine,
  type Milestone,
  type Todo,
} from '../packages/domain/index';
import { isComplete } from '../packages/domain/workspace';
const vaults: Vault[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const v of vaults.splice(0)) {
    await v.close().catch(() => {});
    await fs.rm(v.root, { recursive: true, force: true });
  }
});
async function setup() {
  const vault = await Vault.open(await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-notes-')));
  vaults.push(vault);
  const record = (type: string, fields: object) =>
    parseRecord({
      schemaVersion: 1,
      id: randomUUID(),
      type,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...fields,
    });
  const write = (type: string, fields: object) => vault.save(record(type, fields));
  const project = await write('project', { title: '项目' });
  const line = await write('workline', { title: '论文', projectId: project.data.id });
  const node = await write('milestone', {
    title: '方案会议',
    lineId: line.data.id,
    dueDate: '2026-10-25',
    dueTime: '09:30',
  });
  const todo = await write('todo', { title: '要材料', milestoneId: node.data.id });
  const idea = await write('todo', { title: '替代解释', kind: 'idea', milestoneId: node.data.id });
  const latest = async (entry: Entry) =>
    (await vault.scan()).entries.find((e) => e.data.id === entry.data.id)!;
  const comment = async (entry: Entry, text: string, id = randomUUID()) => {
    const current = await latest(entry);
    return vault.save(current.data, current.revision, {
      comments: [{ id, targetId: current.data.id, text }],
    });
  };
  return { vault, record, write, project, line, node, todo, idea, latest, comment };
}
it('待办日期越过节点后进入本线待办池，Notes 批注移动且冲突仍受保护', async () => {
  const { vault, line, node, todo, idea, comment, latest } = await setup();
  await comment(node, '节点自身纪要');
  await comment(todo, '需要一起移动的批注');
  await comment(idea, '留在原节点的想法');
  let current = await latest(todo);
  current = await vault.save({ ...current.data, dueDate: '2026-10-24' }, current.revision);
  expect(current.data).toMatchObject({ milestoneId: node.data.id, dueDate: '2026-10-24' });
  const moved = await vault.save({ ...current.data, dueDate: '2026-10-26' }, current.revision);
  const state = await vault.scan();
  const pool = state.entries.find(
    (e) => e.data.type === 'milestone' && e.data.lineId === line.data.id && e.data.pool,
  )!;
  expect(moved.data).toMatchObject({
    id: todo.data.id,
    milestoneId: pool.data.id,
    dueDate: '2026-10-26',
  });
  expect((await vault.readContent(pool.data.id)).body).toContain('需要一起移动的批注');
  const original = (await vault.readContent(node.data.id)).body;
  expect(original).toContain('节点自身纪要');
  expect(original).toContain('留在原节点的想法');
  expect(original).not.toContain('需要一起移动的批注');
  expect(state.issues).toEqual([]);
  await expect(
    vault.save({ ...current.data, dueDate: '2026-10-27' }, current.revision),
  ).rejects.toThrow('文件已更改');
});

it('每线自动建立专属 Notes 和池，批注真实保存、按节点和条目分层，纯完成不写纪要', async () => {
  const { vault, line, node, todo, idea, comment, latest } = await setup();
  const snapshot = await vault.scan();
  expect(snapshot.issues).toEqual([]);
  expect(
    snapshot.entries.filter(
      (e) => e.data.type === 'milestone' && e.data.pool && e.data.lineId === line.data.id,
    ),
  ).toHaveLength(1);
  const before = await vault.readContent(line.data.id);
  await comment(node, '会议决定补充对照组');
  await comment(todo, '已联系实验室，等待回复');
  const done = await latest(idea);
  await vault.save(done.data, done.revision, { completion: true });
  const notes = await vault.readContent(line.data.id);
  expect(notes.body).toContain('## 2026-10-25 09:30 · 方案会议');
  expect(notes.body).toContain('### TODO · 要材料');
  expect(notes.body).toContain('会议决定补充对照组');
  expect(notes.body).toContain('已联系实验室');
  expect(notes.body).not.toContain('替代解释');
  expect(before.body).not.toContain('atlas:node');
  expect((await vault.readContent(todo.data.id)).body).toContain('已联系实验室');
  expect(await fs.readFile(path.join(vault.root, notes.path), 'utf8')).toContain(notes.body);
});
it('创建批注、实际表单批注共用原文；关联和完成分离，重复批注 ID 不重复插入', async () => {
  const { vault, record, write, line, node, todo, idea, latest } = await setup();
  const newItem = record('todo', {
    title: '新假设',
    kind: 'idea',
    milestoneId: node.data.id,
  }) as Todo;
  const commentId = randomUUID();
  const actual = await vault.save(
    record('actual', {
      date: '2026-10-25',
      startTime: '10:00',
      endTime: '11:00',
      description: '实验',
      itemIds: [newItem.id, todo.data.id, idea.data.id],
    }),
    undefined,
    {
      newItems: [newItem],
      completeIds: [todo.data.id],
      comments: [
        { id: commentId, targetId: newItem.id, text: '样本不支持原解释', date: '2026-10-25' },
      ],
    },
  );
  expect((await latest(todo)).data).toHaveProperty('completedAt', expect.any(String));
  expect((await latest(idea)).data).toHaveProperty('completedAt', null);
  await vault.save(actual.data, actual.revision, {
    comments: [{ id: commentId, targetId: newItem.id, text: '样本不支持原解释' }],
  });
  expect((await vault.readContent(line.data.id)).body.split('样本不支持原解释')).toHaveLength(2);
  expect((await vault.scan()).issues).toEqual([]);
});
it.each(['todo', 'idea', 'node'])('%s 升线平级独立，仅移动相应正文，脱离旧关联', async (kind) => {
  const { vault, line, node, todo, idea, write, comment, latest } = await setup();
  await comment(node, '会议正文');
  await comment(todo, 'TODO批注');
  await comment(idea, 'IDEA批注');
  const actual = await write('actual', {
    date: '2026-10-25',
    startTime: '09:00',
    endTime: '10:00',
    description: '讨论',
    itemIds: [todo.data.id, idea.data.id],
    milestoneIds: [node.data.id],
  });
  const selected = kind === 'node' ? node : kind === 'todo' ? todo : idea;
  const current = await latest(selected),
    promoted = await vault.promote(current.data.id, current.revision);
  expect(promoted.data.type).toBe('workline');
  expect(promoted.data.id).toBe(selected.data.id);
  expect(promoted.data).not.toHaveProperty('sourceId');
  expect(promoted.data).not.toHaveProperty('lineId');
  const oldText = (await vault.readContent(line.data.id)).body,
    newText = (await vault.readContent(promoted.data.id)).body;
  const own = kind === 'todo' ? 'TODO批注' : kind === 'idea' ? 'IDEA批注' : '会议正文';
  expect(oldText).not.toContain(own);
  expect(newText).toContain(own);
  if (kind === 'node') {
    expect((await latest(actual)).data).toHaveProperty('milestoneIds', []);
    expect(newText).toContain('2026-10-25 09:30');
    expect(newText).toContain('TODO批注');
    expect((await vault.readContent(todo.data.id)).body).toContain('TODO批注');
    const after = await vault.scan();
    expect(
      after.entries.some(
        (e) =>
          e.data.type === 'milestone' &&
          e.data.lineId === promoted.data.id &&
          e.data.dueDate === '2026-10-25' &&
          e.data.dueTime === '09:30',
      ),
    ).toBe(true);
  } else {
    expect(oldText).toContain('会议正文');
    const updated = (await latest(actual)).data;
    expect(updated.type === 'actual' && updated.itemIds).not.toContain(selected.data.id);
  }
  expect((await vault.scan()).issues).toEqual([]);
  expect((await vault.promote(selected.data.id, current.revision)).data.id).toBe(selected.data.id);
});
it('完成节点批量完成条目、可重新打开；不会完成业务线或项目，池不可完成', async () => {
  const { vault, node, todo, idea, line, project, latest } = await setup();
  await vault.save(node.data, node.revision, { completion: true });
  let snapshot = await vault.scan();
  expect(isComplete((await latest(node)).data, snapshot.entries)).toBe(true);
  expect((await latest(line)).data).toHaveProperty('completedAt', null);
  expect((await latest(project)).data).toHaveProperty('completedAt', null);
  const done = await latest(node);
  await vault.save(done.data, done.revision, { completion: false });
  expect((await latest(todo)).data).toHaveProperty('completedAt', null);
  expect((await latest(idea)).data).toHaveProperty('completedAt', null);
  const pool = (await vault.scan()).entries.find(
    (e) => e.data.type === 'milestone' && e.data.pool,
  )!;
  await expect(vault.save(pool.data, pool.revision, { completion: true })).rejects.toThrow(
    '待办池',
  );
});
it('Notes 外部修改产生冲突，移动后按稳定 ID 找回，保留其他字段和自由正文', async () => {
  const { vault, line } = await setup();
  const first = await vault.readContent(line.data.id),
    absolute = path.join(vault.root, first.path);
  await fs.appendFile(absolute, '\n用户自由正文\n');
  await expect(vault.saveContent(line.data.id, '网页草稿', first.revision)).rejects.toThrow(
    '外部修改',
  );
  const moved = path.join(vault.root, '论文Notes.md');
  await fs.rename(absolute, moved);
  const current = await vault.readContent(line.data.id);
  expect(current.path).toBe('论文Notes.md');
  await vault.saveContent(line.data.id, current.body + '\n新结论', current.revision);
  expect(await fs.readFile(moved, 'utf8')).toContain('用户自由正文');
});
it('中断发布留下短期日志，重新连接完成升线，正文只移动一次且不生成备份', async () => {
  const { vault, todo, line, comment, latest } = await setup();
  await comment(todo, '必须完整保留的批注');
  const current = await latest(todo);
  const original = fs.rename.bind(fs);
  let writes = 0;
  vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
    if (++writes === 2) throw new Error('模拟中断');
    return original(...args);
  });
  await expect(vault.promote(todo.data.id, current.revision)).rejects.toThrow('模拟中断');
  vi.restoreAllMocks();
  await vault.close();
  vaults.splice(vaults.indexOf(vault), 1);
  const reopened = await Vault.open(vault.root);
  vaults.push(reopened);
  expect((await reopened.scan()).issues).toEqual([]);
  expect((await reopened.readContent(todo.data.id)).body).toContain('必须完整保留');
  expect((await reopened.readContent(line.data.id)).body).not.toContain('必须完整保留');
  await expect(fs.stat(path.join(reopened.root, '.atlas/pending.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await reopened.backups()).toEqual([]);
});

it('同一服务重新连接可以恢复未完成操作；外部修改时停止并保留原文', async () => {
  const { vault, todo, comment, latest } = await setup();
  await comment(todo, '不能丢失的批注');
  const current = await latest(todo);
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('模拟磁盘拒绝'));
  await expect(vault.promote(todo.data.id, current.revision)).rejects.toThrow('模拟磁盘拒绝');
  vi.restoreAllMocks();
  expect((await vault.scan()).issues.some((issue) => issue.path === '.atlas/pending.json')).toBe(
    true,
  );
  const source = await fs.readFile(path.join(vault.root, todo.path), 'utf8');
  await fs.appendFile(path.join(vault.root, todo.path), '\n外部编辑\n');
  await expect(vault.recover()).rejects.toThrow('外部修改');
  expect(await fs.readFile(path.join(vault.root, todo.path), 'utf8')).toContain('外部编辑');
  await fs.writeFile(path.join(vault.root, todo.path), source);
  await vault.recover();
  expect((await vault.scan()).issues).toEqual([]);
  expect((await vault.readContent(todo.data.id)).body).toContain('不能丢失的批注');
});
