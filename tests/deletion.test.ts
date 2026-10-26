import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vault } from '../apps/local-service/src/vault';
import { parseRecord, type Entry } from '../packages/domain/index';
const vaults: Vault[] = [];
afterEach(async () => {
  for (const v of vaults.splice(0)) {
    await v.close();
    await fs.rm(v.root, { recursive: true, force: true });
  }
});
const expectations = (entries: Entry[]) =>
  Object.fromEntries(entries.map((e) => [e.data.id, e.revision]));
async function setup() {
  const vault = await Vault.open(await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-delete-')));
  vaults.push(vault);
  const save = (type: string, fields: object) =>
    vault.save(
      parseRecord({
        schemaVersion: 1,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        type,
        ...fields,
      }),
    );
  const project = await save('project', { title: '项目' });
  const line = await save('workline', { title: '研究', projectId: project.data.id });
  const node = await save('milestone', { title: '实验', lineId: line.data.id });
  const todo = await save('todo', { title: '动作', milestoneId: node.data.id });
  const other = await save('project', { title: '其他项目' });
  const actual = await save('actual', {
    date: '2026-10-25',
    startTime: '09:00',
    endTime: '10:00',
    description: '实验实际时间',
    itemIds: [todo.data.id],
    milestoneIds: [node.data.id],
  });
  await vault.save(todo.data, todo.revision, {
    comments: [{ id: randomUUID(), targetId: todo.data.id, text: '保留的用户批注' }],
  });
  return { vault, save, project, line, node, todo, other, actual };
}
it.each(['project', 'line', 'node', 'todo'] as const)(
  '删除 %s 解除实际关联，保留时间、Notes 正文、其他项目，不留下失效引用',
  async (level) => {
    const data = await setup(),
      { vault, line, other, actual } = data;
    const notes = await vault.readContent(line.data.id),
      before = await vault.backups();
    const preview = await vault.deletePreview(data[level].data.id);
    expect(preview.blockedReason).toBeNull();
    const result = await vault.deleteSpace(data[level].data.id, expectations(preview.entries));
    const after = await vault.scan();
    expect(after.issues).toEqual([]);
    expect(after.entries.some((e) => e.data.id === other.data.id)).toBe(true);
    const kept = after.entries.find((e) => e.data.id === actual.data.id)!.data;
    expect(kept).toHaveProperty('milestoneIds', level === 'todo' ? [data.node.data.id] : []);
    expect(kept).toMatchObject({
      itemIds: [],
      startTime: '09:00',
      endTime: '10:00',
      description: '实验实际时间',
    });
    expect(await fs.readFile(path.join(vault.root, notes.path), 'utf8')).toContain(
      '保留的用户批注',
    );
    expect(await fs.readFile(path.join(vault.root, notes.path), 'utf8')).not.toContain(
      'atlas:item ' + data.todo.data.id,
    );
    expect(await vault.backups()).toEqual(before);
    for (const id of result.deletedIds)
      expect(after.entries.some((e) => e.data.id === id)).toBe(false);
    await expect(fs.stat(path.join(vault.root, '.atlas/trash'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);
it('过期删除范围、外部修改和重复 ID 均拒绝，保留所有未发布内容', async () => {
  const { vault, node, todo, save } = await setup();
  const preview = await vault.deletePreview(node.data.id);
  await save('todo', { title: '刚新增', milestoneId: node.data.id });
  await expect(vault.deleteSpace(node.data.id, expectations(preview.entries))).rejects.toThrow(
    '范围',
  );
  const fresh = await vault.deletePreview(todo.data.id);
  await fs.appendFile(path.join(vault.root, todo.path), '\n外部新正文\n');
  await expect(vault.deleteSpace(todo.data.id, expectations(fresh.entries))).rejects.toThrow(
    '更改',
  );
  expect(await fs.readFile(path.join(vault.root, todo.path), 'utf8')).toContain('外部新正文');
  await fs.copyFile(path.join(vault.root, todo.path), path.join(vault.root, '重复.md'));
  expect((await vault.deletePreview(node.data.id)).blockedReason).toContain('诊断');
});
it('池不能单独删除；业务线删除包含池但保留专属 Notes', async () => {
  const { vault, line } = await setup();
  const snapshot = await vault.scan();
  const pool = snapshot.entries.find((e) => e.data.type === 'milestone' && e.data.pool)!;
  expect((await vault.deletePreview(pool.data.id)).blockedReason).toContain('待办池');
  const preview = await vault.deletePreview(line.data.id);
  expect(preview.entries.some((e) => e.data.id === pool.data.id)).toBe(true);
});
