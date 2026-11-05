import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../apps/local-service/src/native/vault';
import { createRecord } from '../packages/domain/index';
import { newNote, updateNote } from '../packages/workspace/markdown';
import { recordPath, layoutPath } from '../packages/workspace/layout';

const roots: string[] = [];
const opened: Vault[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const vault of opened.splice(0)) await vault.close().catch(() => {});
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-layout-'));
  roots.push(root);
  const vault = await Vault.open(root);
  opened.push(vault);
  const project = await vault.save(createRecord('project', { title: '合成项目' }));
  const line = await vault.save(
    createRecord('workline', { title: '合成业务', projectId: project.data.id }),
  );
  const node = await vault.save(
    createRecord('milestone', { title: '受保护节点', lineId: line.data.id }),
  );
  let todo = await vault.save(
    createRecord('todo', { title: '受保护条目', milestoneId: node.data.id }),
  );
  todo = await vault.save(todo.data, todo.revision, {
    comments: [{ id: crypto.randomUUID(), targetId: todo.data.id, text: '原批注' }],
  });
  return { root, vault, project, line, node, todo };
}
it('内容编辑不暴露标记、标题或子项，不能提交结构或其他条目的批注 ID', async () => {
  const { vault, line, node, todo } = await setup();
  const before = await vault.snapshot();
  const original = await vault.readContent(todo.data.id);
  expect(original.body).toBe('');
  expect(original.comments).toEqual([expect.objectContaining({ text: '原批注' })]);
  expect(JSON.stringify(original)).not.toContain('atlas:');
  await expect(vault.saveContent(line.data.id, '替换整线', original.revision)).rejects.toThrow(
    '只读汇总',
  );
  await expect(
    vault.saveContent(todo.data.id, '<!-- atlas:node fake -->', original.revision),
  ).rejects.toThrow('结构标记');
  await expect(
    vault.saveContent(todo.data.id, '', original.revision, [
      { id: crypto.randomUUID(), text: '越界' },
    ]),
  ).rejects.toThrow('不属于');
  const edited = await vault.saveContent(
    todo.data.id,
    '    只修改此条目的内部正文',
    original.revision,
    original.comments!.map(({ id }) => ({ id, text: '修改后的批注' })),
  );
  expect(edited.body).toBe('    只修改此条目的内部正文');
  expect(edited.comments).toEqual([{ ...original.comments![0], text: '修改后的批注' }]);
  const parent = await vault.readContent(node.data.id);
  expect(parent.body).not.toContain('条目');
  expect(parent.comments).toEqual([]);
  const aggregate = await vault.readContent(line.data.id);
  expect(
    aggregate.sections?.find((section) => section.id === todo.data.id)?.comments?.[0].text,
  ).toBe('修改后的批注');
  expect(aggregate.body).not.toContain('atlas:');
  const after = await vault.snapshot();
  for (const entry of before.entries.filter((entry) => entry.data.type !== 'resource'))
    expect(after.entries.find((current) => current.data.id === entry.data.id)).toEqual(entry);
});

async function legacyFixture() {
  const state = await setup();
  const snapshot = await state.vault.snapshot();
  const sources = new Map<string, string>();
  await state.vault.close();
  opened.splice(opened.indexOf(state.vault), 1);
  for (const entry of snapshot.entries) {
    let source = await fs.readFile(path.join(state.root, entry.path), 'utf8');
    if (entry.data.type === 'project')
      source =
        '\ufeff' +
        source.replace('atlas:', 'external: keep # 自由字段\natlas:').replaceAll('\n', '\r\n') +
        '\r\n保留原文\r\n';
    const legacy = `ATLAS/${entry.data.type}/${entry.data.id}.md`;
    if (entry.data.type === 'resource' && entry.data.noteId === entry.data.id)
      source = updateNote(source, { ...entry.data, target: legacy });
    await fs.mkdir(path.dirname(path.join(state.root, legacy)), { recursive: true });
    await fs.writeFile(path.join(state.root, legacy), source);
    await fs.unlink(path.join(state.root, entry.path));
    sources.set(legacy, source);
  }
  await fs.unlink(path.join(state.root, layoutPath));
  const backupId = crypto.randomUUID();
  await fs.mkdir(path.join(state.root, '.atlas/backups'), { recursive: true });
  await fs.writeFile(
    path.join(state.root, '.atlas/backups', backupId + '.json'),
    JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      files: [...sources].map(([path, content]) => ({ path, content })),
    }),
  );
  return { ...state, sources, backupId };
}
it('首次启动自动转换旧路径，标志与记录同批发布；后续启动不再扫描普通资料或重复转换', async () => {
  const { root, sources, todo, project, line, backupId } = await legacyFixture();
  await fs.writeFile(path.join(root, '用户笔记.md'), '用户原文');
  const vault = await Vault.open(root);
  opened.push(vault);
  const snapshot = await vault.snapshot(false);
  expect(snapshot.entries.every((entry) => entry.path === recordPath(entry.data.id))).toBe(true);
  for (const legacy of sources.keys())
    await expect(fs.stat(path.join(root, legacy))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await vault.readContent(todo.data.id)).comments?.[0].text).toBe('原批注');
  expect(await fs.readFile(path.join(root, recordPath(project.data.id)), 'utf8')).toBe(
    sources.get(`ATLAS/project/${project.data.id}.md`),
  );
  const notes = await vault.readContent(line.data.id);
  await vault.appendContent(line.data.id, '备份恢复前的临时内容', notes.revision);
  await vault.restore(
    backupId,
    Object.fromEntries(
      (await vault.snapshot()).entries.map((entry) => [entry.data.id, entry.revision]),
    ),
  );
  const restored = await vault.snapshot(false);
  const resource = restored.entries.find((entry) => entry.data.type === 'resource')!;
  expect(resource.data).toHaveProperty('target', resource.path);
  expect((await vault.readContent(line.data.id)).body).not.toContain('备份恢复前的临时内容');
  expect(await fs.readFile(path.join(root, '用户笔记.md'), 'utf8')).toBe('用户原文');
  const marker = await fs.readFile(path.join(root, layoutPath), 'utf8');
  await vault.close();
  opened.splice(opened.indexOf(vault), 1);
  await fs.mkdir(path.join(root, '普通资料'));
  await fs.writeFile(path.join(root, '普通资料/不应读取.md'), Buffer.from([255]));
  const reads = vi.spyOn(fs, 'readdir');
  const restarted = await Vault.open(root);
  opened.push(restarted);
  expect((await restarted.snapshot(false)).issues).toEqual([]);
  expect(reads.mock.calls.some(([file]) => String(file).endsWith('普通资料'))).toBe(false);
  expect(await fs.readFile(path.join(root, layoutPath), 'utf8')).toBe(marker);
});
it('转换中断保留恢复日志，下次启动先完成转换再使用标志', async () => {
  const { root, todo } = await legacyFixture();
  const link = fs.link.bind(fs);
  let published = 0;
  vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
    if (String(to).includes(path.join('ATLAS', 'records')) && ++published === 2)
      throw new Error('模拟转换中断');
    return link(from, to);
  });
  await expect(Vault.open(root)).rejects.toThrow('模拟转换中断');
  vi.restoreAllMocks();
  expect(await fs.stat(path.join(root, '.atlas/pending.json'))).toBeTruthy();
  const recovered = await Vault.open(root);
  opened.push(recovered);
  expect((await recovered.readContent(todo.data.id)).comments?.[0].text).toBe('原批注');
  expect(await fs.stat(path.join(root, layoutPath))).toBeTruthy();
  await expect(fs.stat(path.join(root, '.atlas/pending.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
it('旧路径手工链接有歧义时停止自动转换，不写标志或移动原文件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-layout-link-'));
  roots.push(root);
  const data = createRecord('project', { title: '保留链接' });
  const legacy = `old/${data.id}.md`;
  await fs.mkdir(path.join(root, 'old'));
  await fs.writeFile(path.join(root, legacy), newNote(data));
  await fs.writeFile(path.join(root, '用户笔记.md'), `[原文](${legacy})`);
  await expect(Vault.open(root)).rejects.toThrow('手工链接');
  expect(await fs.readFile(path.join(root, legacy), 'utf8')).toBe(newNote(data));
  await expect(fs.stat(path.join(root, layoutPath))).rejects.toMatchObject({ code: 'ENOENT' });
});
