import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vault, decodeNote, newNote, updateNote } from '../../apps/local-service/src/vault';
import { parseRecord, type RecordData } from '../../packages/domain/index';
const roots: string[] = [],
  opened: Vault[] = [];
const make = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-test-'));
  roots.push(root);
  const vault = await Vault.open(root);
  opened.push(vault);
  return vault;
};
const record = (type: string, fields: object) =>
  parseRecord({
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type,
    ...fields,
  });
afterEach(async () => {
  for (const v of opened.splice(0)) await v.close().catch(() => {});
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
describe('R0.1 真正的 Markdown 文件安全闭环', () => {
  it('标签笔记单文件落盘、同名不覆盖、外部正文保留、移动后按 ID 找回', async () => {
    const v = await make();
    const first = await v.createMarkdown({ title: '讨论 / 结论', kind: 'meeting', tag: '科研' });
    const second = await v.createMarkdown({ title: '讨论 / 结论', tag: '科研' });
    expect(first.path).toMatch(/^ATLAS\/knowledge\/科研\/讨论 - 结论-.*\.md$/);
    expect(second.path).not.toBe(first.path);
    expect(first.data).toMatchObject({
      type: 'resource',
      kind: 'meeting',
      tag: '科研',
      noteId: first.data.id,
    });
    const absolute = path.join(v.root, first.path);
    await fs.appendFile(absolute, '\n用户的会议正文\n');
    await expect(v.save({ ...first.data, title: '冲突' }, first.revision)).rejects.toThrow('更改');
    const current = (await v.scan()).entries.find((e) => e.data.id === first.data.id)!;
    await v.save({ ...current.data, kind: 'draft' }, current.revision);
    expect(await fs.readFile(absolute, 'utf8')).toContain('用户的会议正文');
    await fs.rename(absolute, path.join(v.root, '会议.md'));
    expect(await v.resolveResource(first.data.id)).toMatchObject({ target: '会议.md' });
    expect((await v.scan()).issues).toEqual([]);
  });
  it('非法标签和符号链接不创建笔记，解除资料引用不修改原 Markdown', async () => {
    const v = await make();
    for (const tag of [
      '../越界',
      'a/b',
      'a\\b',
      '.',
      'CON',
      'a:',
      'x.',
      '.git',
      '.atlas',
      '.obsidian',
      'node_modules',
    ])
      await expect(v.createMarkdown({ title: '拒绝创建', tag })).rejects.toThrow();
    expect((await v.scan()).entries).toEqual([]);
    const plain = '---\ntags: [原有]\n---\n原始正文 **保留**';
    await fs.writeFile(path.join(v.root, '原有.md'), plain);
    const resource = await v.save(
      record('resource', { title: '原有', target: '原有.md', location: 'vault' }),
    );
    const project = await v.save(record('project', { title: '项目' }));
    const line = await v.save(record('workline', { title: '研究', projectId: project.data.id }));
    const point = await v.save(
      record('milestone', { title: '讨论', lineId: line.data.id, resourceIds: [resource.data.id] }),
    );
    await v.save({ ...point.data, resourceIds: [] }, point.revision);
    expect(await fs.readFile(path.join(v.root, '原有.md'), 'utf8')).toBe(plain);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-outside-'));
    roots.push(outside);
    await fs.mkdir(path.join(v.root, 'ATLAS/knowledge'), { recursive: true });
    await fs.symlink(outside, path.join(v.root, 'ATLAS/knowledge/链接'), 'junction');
    await expect(v.createMarkdown({ title: '拒绝', tag: '链接' })).rejects.toThrow('链接');
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it('保留正文、其他 YAML 字段和注释，包括 CRLF 与空行', () => {
    expect(decodeNote('---\n---\n普通笔记')).toBeNull();
    expect(decodeNote('正文\n---\natlas: fake\n---\n')).toBeNull();
    const data = record('project', { title: '研究' });
    expect(decodeNote('这是一段普通正文\n' + newNote(data))).toBeNull();
    for (const newline of ['\n', '\r\n']) {
      const raw =
        newNote(data)
          .replace('atlas:', '# 不归 ATLAS 所有\ntags: [科研, A]\ncustom: "保留格式"\natlas:')
          .replace('---\n\n#', '# 尾部注释\n---\n\n#')
          .replaceAll('\n', newline) + '用户正文 **保持**\n';
      const changed = updateNote(raw, { ...data, title: '新标题' } as RecordData);
      expect(decodeNote(changed)?.data).toMatchObject({ title: '新标题' });
      expect(changed.slice(changed.indexOf(newline + '---' + newline))).toBe(
        raw.slice(raw.indexOf(newline + '---' + newline)),
      );
      expect(changed).toContain(
        '# 不归 ATLAS 所有' + newline + 'tags: [科研, A]' + newline + 'custom: "保留格式"',
      );
      expect(changed).toContain('# 尾部注释');
    }
  });
  it('创建、重启、外部修改、移动文件、稳定 ID 和冲突阻止', async () => {
    const v = await make();
    const first = await v.save(record('project', { title: '科研' }));
    const filename = path.join(v.root, first.path);
    const raw = await fs.readFile(filename, 'utf8');
    await fs.writeFile(filename, raw + '\nObsidian 新增内容\n');
    await expect(v.save({ ...first.data, title: '错误覆盖' }, first.revision)).rejects.toThrow(
      '更改',
    );
    await fs.rename(filename, path.join(v.root, '改名.md'));
    const current = (await v.scan()).entries[0];
    expect(current.data.id).toBe(first.data.id);
    await v.save({ ...current.data, title: '继续科研' }, current.revision);
    expect(await fs.readFile(path.join(v.root, '改名.md'), 'utf8')).toContain('Obsidian 新增内容');
    await v.close();
    opened.splice(opened.indexOf(v), 1);
    const reopened = await Vault.open(v.root);
    opened.push(reopened);
    expect((await reopened.scan()).entries[0].data).toMatchObject({ title: '继续科研' });
  });
  it('重复 ID、非法 YAML、普通笔记不被写入', async () => {
    const v = await make();
    const e = await v.save(record('project', { title: 'A' }));
    await fs.copyFile(path.join(v.root, e.path), path.join(v.root, '副本.md'));
    await fs.writeFile(path.join(v.root, '损坏.md'), '---\natlas: [oops\n---\n正文');
    await fs.writeFile(path.join(v.root, '普通.md'), '---\ntags: [hello]\n---\n原始知识');
    const snapshot = await v.scan();
    expect(snapshot.issues.some((i) => i.message.includes('重复 ID'))).toBe(true);
    expect(snapshot.issues.some((i) => i.message.includes('Frontmatter'))).toBe(true);
    await expect(v.save({ ...e.data, title: 'B' }, e.revision)).rejects.toThrow('重复 ID');
    expect(await fs.readFile(path.join(v.root, '普通.md'), 'utf8')).toBe(
      '---\ntags: [hello]\n---\n原始知识',
    );
  });
  it('手动快照、恢复前冲突校验与恢复后内容', async () => {
    const v = await make();
    const first = await v.save(record('project', { title: 'V1' }));
    const backup = await v.backup();
    const second = await v.save({ ...first.data, title: 'V2' }, first.revision);
    await expect(v.restore(backup.id, { [first.data.id]: first.revision })).rejects.toThrow('冲突');
    expect(await v.restore(backup.id, { [first.data.id]: second.revision })).toEqual({
      restored: 1,
    });
    expect((await v.scan()).entries[0].data).toMatchObject({ title: 'V1' });
    expect((await v.backups()).length).toBe(1);
  });
  it('路径穿越、符号链接和多个本地服务均被拒绝', async () => {
    const v = await make();
    for (const p of [
      '../outside',
      'ATLAS/../../secret',
      'C:\\Windows\\x',
      '/etc/passwd',
      'test:stream',
      'ATLAS/../x',
      'ATLAS./x',
    ])
      await expect(v.safe(p, true)).rejects.toThrow();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-outside-'));
    roots.push(outside);
    await fs.symlink(outside, path.join(v.root, 'link'), 'junction');
    await expect(v.safe('link/escape.md', true)).rejects.toThrow('链接');
    await expect(Vault.open(v.root)).rejects.toThrow('已由');
    expect((await v.scan()).issues.some((i) => i.path === 'link')).toBe(true);
  });
  it('写入失败保留原文，中断临时文件不自动提升', async () => {
    const v = await make();
    const first = await v.save(record('project', { title: '原文' }));
    const original = await fs.readFile(path.join(v.root, first.path), 'utf8');
    await fs.mkdir(path.join(v.root, '.atlas/backups'));
    await fs.writeFile(path.join(v.root, '.atlas/backups/not-json.txt'), 'ignore');
    const { vi } = await import('vitest');
    const rename = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('模拟磁盘拒绝'), { code: 'EACCES' }));
    await expect(v.save({ ...first.data, title: '新文' }, first.revision)).rejects.toThrow(
      '磁盘拒绝',
    );
    rename.mockRestore();
    expect(await fs.readFile(path.join(v.root, first.path), 'utf8')).toBe(original);
    await fs.writeFile(path.join(v.root, 'interrupted.md.atlas-tmp-test'), 'unfinished');
    expect((await v.scan()).issues.some((i) => i.message.includes('中断'))).toBe(true);
  });
  it('资源移动以稳定笔记 ID 或唯一内容指纹恢复关联', async () => {
    const v = await make();
    await fs.writeFile(path.join(v.root, '报告.docx'), 'fixture-docx-bytes');
    const r = await v.save(
      record('resource', { title: '报告', target: '报告.docx', location: 'vault' }),
    );
    await fs.rename(path.join(v.root, '报告.docx'), path.join(v.root, 'V2.docx'));
    expect(await v.resolveResource(r.data.id)).toMatchObject({ target: 'V2.docx' });
  });
  it('非法 UTF-8 和关闭后的迟到保存不会损坏文件', async () => {
    const v = await make();
    const entry = await v.save(record('project', { title: '编码保护' }));
    const filename = path.join(v.root, entry.path);
    const raw = Buffer.concat([await fs.readFile(filename), Buffer.from([0xff])]);
    await fs.writeFile(filename, raw);
    expect((await v.scan()).issues.some((i) => i.message.includes('UTF-8'))).toBe(true);
    await expect(v.save({ ...entry.data, title: '拒绝覆盖' }, entry.revision)).rejects.toThrow();
    expect(await fs.readFile(filename)).toEqual(raw);
    await v.close();
    opened.splice(opened.indexOf(v), 1);
    await expect(v.save(record('project', { title: '迟到请求' }))).rejects.toThrow('关闭');
  });
});
