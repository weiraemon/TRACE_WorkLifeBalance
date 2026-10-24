import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseDocument, stringify, isMap } from 'yaml';
import { z } from 'zod';
import {
  parseRecord,
  validateChange,
  noteInputSchema,
  actualTodoIds,
  type Entry,
  type Snapshot,
  type RecordData,
  type MilestoneContent,
  type DeletePreview,
  type DeleteResult,
} from '../../../packages/domain/index';
import { spaceSubtree } from '../../../packages/domain/workspace';

export class VaultError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const slash = (value: string) => value.split(path.sep).join('/');
const ignored = new Set(['.git', '.obsidian', '.atlas', 'node_modules']);
const deletionLevels = { project: 0, workline: 1, milestone: 2, todo: 3 };
const frontmatter = /^(\uFEFF?---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/m;
const backupSchema = z.object({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  files: z.array(z.object({ path: z.string().min(1), content: z.string() })),
});
const backupName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/;
async function readText(filename: string) {
  const bytes = await fs.readFile(filename);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new VaultError('笔记不是有效 UTF-8，拒绝修改；请先在原编辑器检查编码');
  }
}

// Replace only our top-level YAML value; other keys, comments and body remain byte-for-byte intact.
export function decodeNote(source: string) {
  const match = frontmatter.exec(source);
  if (!match || match.index !== 0) {
    if (/^\uFEFF?---(?:\r?\n|$)/.test(source)) throw new VaultError('Frontmatter 未闭合');
    return null;
  }
  if (!match[2].trim()) return null;
  const document = parseDocument(match[2], { uniqueKeys: true });
  if (document.errors.length || !isMap(document.contents))
    throw new VaultError('非法 Frontmatter：' + (document.errors[0]?.message ?? '必须为映射'));
  const atlas = document.get('atlas', true);
  if (!atlas) return null;
  const object = document.toJS({ maxAliasCount: 20 });
  if (!object.atlas || object.atlas.managed !== true) return null;
  return { data: parseRecord(object.atlas.record), match, document };
}
export function updateNote(source: string, data: RecordData) {
  const note = decodeNote(source);
  if (!note) throw new VaultError('该文件不属于 ATLAS，拒绝修改');
  const pair = (note.document.contents as import('yaml').YAMLMap).items.find(
    (p) => String(p.key) === 'atlas',
  );
  const range = (pair?.value as import('yaml').Node | undefined)?.range;
  if (!range) throw new VaultError('无法安全定位 ATLAS 字段');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const replacement =
    '\n' +
    stringify({ managed: true, record: data })
      .trimEnd()
      .split('\n')
      .map((line) => '  ' + line)
      .join(newline) +
    newline;
  const yaml = note.match[2];
  return (
    note.match[1] +
    yaml.slice(0, range[0]) +
    replacement +
    yaml.slice(range[2]) +
    source.slice(note.match[1].length + yaml.length)
  );
}
export const newNote = (data: RecordData) =>
  `---\n${stringify({ atlas: { managed: true, record: data } })}---\n\n# ${'title' in data ? data.title : 'ATLAS ' + data.type}\n\n`;

export class Vault {
  readonly sessionId = randomUUID();
  private closing = false;
  private tail: Promise<unknown> = Promise.resolve();
  private lockToken = randomUUID();
  private constructor(public root: string) {}
  static async open(input: string) {
    if (!path.isAbsolute(input)) throw new VaultError('Vault 需要绝对路径');
    const root = await fs.realpath(input);
    if (!(await fs.stat(root)).isDirectory()) throw new VaultError('Vault 必须是目录');
    const vault = new Vault(root);
    await vault.safe('.atlas', true);
    await fs.mkdir(path.join(root, '.atlas'), { recursive: true });
    try {
      await fs.writeFile(
        await vault.safe('.atlas/service.lock', true),
        JSON.stringify({ pid: process.pid, token: vault.lockToken }),
        { flag: 'wx' },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new VaultError(
          'Vault 已由一个 ATLAS 服务打开；异常退出时请核实进程后移除 .atlas/service.lock',
          409,
        );
      throw error;
    }
    return vault;
  }
  async close() {
    this.closing = true;
    await this.tail;
    const lock = await this.safe('.atlas/service.lock');
    const data = JSON.parse(await fs.readFile(lock, 'utf8'));
    if (data.token === this.lockToken) await fs.unlink(lock);
  }
  async safe(relative: string, missing = false) {
    if (
      !relative ||
      relative.includes('\0') ||
      path.isAbsolute(relative) ||
      relative.includes(':') ||
      relative.split(/[\\/]/).some((s) => s === '..' || /[. ]$/.test(s))
    )
      throw new VaultError('非法路径 / 路径越界');
    const target = path.resolve(this.root, relative),
      rel = path.relative(this.root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new VaultError('路径越界');
    let current = this.root;
    for (const piece of rel.split(path.sep)) {
      current = path.join(current, piece);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new VaultError('拒绝符号链接 / Junction');
      } catch (error) {
        if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    return target;
  }
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closing) throw new VaultError('Vault 已关闭或正在切换，请重新连接', 409);
    const task = this.tail.then(fn);
    this.tail = task.catch(() => {});
    return task;
  }
  async scan(): Promise<Snapshot> {
    // shortcut: full scans suit R0; add an incremental index only after large-Vault measurements.
    const entries: Entry[] = [],
      files: Snapshot['files'] = [],
      issues: Snapshot['issues'] = [];
    const walk = async (relative: string) => {
      let children;
      try {
        children = await fs.readdir(relative ? await this.safe(relative) : this.root, {
          withFileTypes: true,
        });
      } catch (error) {
        issues.push({ path: relative, message: String(error) });
        return;
      }
      for (const child of children) {
        if (ignored.has(child.name)) continue;
        const filename = relative ? `${relative}/${child.name}` : child.name;
        if (child.isSymbolicLink()) {
          issues.push({ path: filename, message: '已跳过符号链接' });
          continue;
        }
        if (child.name.includes('.atlas-tmp-')) {
          issues.push({
            path: filename,
            message: '发现中断写入临时文件，未自动覆盖原文件；请检查备份',
          });
          continue;
        }
        files.push({ path: filename, directory: child.isDirectory() });
        if (child.isDirectory()) {
          await walk(filename);
          continue;
        }
        if (!child.name.endsWith('.md')) continue;
        try {
          const absolute = await this.safe(filename);
          const stat = await fs.stat(absolute);
          if (stat.size > 5 * 1024 * 1024) {
            issues.push({ path: filename, message: '笔记超过 5 MB，已跳过结构化索引' });
            continue;
          }
          const source = await readText(absolute);
          const note = decodeNote(source);
          if (note) entries.push({ data: note.data, path: filename, revision: hash(source) });
        } catch (error) {
          issues.push({
            path: filename,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    await walk('');
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.data.id, (counts.get(e.data.id) ?? 0) + 1);
    for (const e of entries)
      if (counts.get(e.data.id)! > 1)
        issues.push({ path: e.path, message: '重复 ID：' + e.data.id + '；已禁止写入这些记录' });
    for (const e of entries) {
      try {
        validateChange(e.data, entries);
      } catch (error) {
        issues.push({
          path: e.path,
          message: '关联或时间诊断：' + (error instanceof Error ? error.message : String(error)),
        });
      }
    }
    return { root: this.root, vaultId: this.sessionId, entries, files, issues };
  }
  private async atomic(relative: string, content: string, expected: string | null) {
    const target = await this.safe(relative, true),
      dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true });
    const parentRelative = slash(path.relative(this.root, dir));
    if (parentRelative) await this.safe(parentRelative);
    const tempRelative = relative + '.atlas-tmp-' + randomUUID();
    const temp = await this.safe(tempRelative, true);
    let handle;
    try {
      handle = await fs.open(temp, 'wx');
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.safe(relative, true);
      if (expected === null) {
        await fs.link(temp, target);
        await fs.unlink(temp);
      } else {
        const latest = await readText(target);
        if (hash(latest) !== expected)
          throw new VaultError('文件已被外部修改，请重新加载后再保存', 409);
        await fs.rename(temp, target);
      }
    } finally {
      await handle?.close();
      await fs.unlink(temp).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  async save(input: unknown, revision?: string): Promise<Entry> {
    return this.serialized(async () => {
      let data = parseRecord(input);
      const snapshot = await this.scan();
      const matches = snapshot.entries.filter((e) => e.data.id === data.id);
      if (matches.length > 1) throw new VaultError('重复 ID，拒绝写入', 409);
      const existing = matches[0];
      if (existing && (revision !== existing.revision || existing.data.type !== data.type))
        throw new VaultError('文件已更改，请重新加载；未覆盖你的编辑', 409);
      if (!existing && revision)
        throw new VaultError('原记录已移除或无法读取，请检查 Vault 诊断', 409);
      if (data.type === 'actual') {
        const previous = existing?.data;
        data = {
          ...data,
          history:
            previous?.type === 'actual'
              ? [
                  ...previous.history,
                  {
                    changedAt: new Date().toISOString(),
                    date: previous.date,
                    startTime: previous.startTime,
                    endTime: previous.endTime,
                    description: previous.description,
                  },
                ]
              : [],
        };
      }
      if (data.type === 'resource' && data.location === 'vault' && data.noteId !== data.id) {
        const target = await this.safe(data.target);
        const stat = await fs.stat(target);
        const targetPath = slash(data.target);
        const note = snapshot.entries.find((e) => e.path === targetPath);
        data = {
          ...data,
          fingerprint: stat.isFile() ? hash(await fs.readFile(target)) : null,
          noteId: note?.data.id ?? null,
        };
      }
      if (
        data.type === 'resource' &&
        data.noteId === data.id &&
        (!existing ||
          existing.data.type !== 'resource' ||
          existing.data.noteId !== data.id ||
          data.target !== existing.data.target ||
          data.tag !== existing.data.tag)
      )
        throw new VaultError('笔记路径和标签由创建时确定，请在 Obsidian 中整理文件');
      validateChange(data, snapshot.entries);
      const now = new Date().toISOString();
      data = { ...data, createdAt: existing?.data.createdAt ?? data.createdAt, updatedAt: now };
      const relative = existing?.path ?? `ATLAS/${data.type}/${data.id}.md`;
      let source = newNote(data);
      if (existing) {
        const original = await readText(await this.safe(relative));
        if (hash(original) !== revision) throw new VaultError('外部修改冲突', 409);
        source = updateNote(original, data);
      }
      await this.atomic(relative, source, existing?.revision ?? null);
      return { data, path: relative, revision: hash(source) };
    });
  }
  async createMarkdown(input: unknown): Promise<Entry> {
    const fields = noteInputSchema.parse(input);
    return this.serialized(async () => {
      const id = randomUUID(),
        now = new Date().toISOString();
      const name =
        fields.title
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
          .replace(/[. ]+$/g, '')
          .slice(0, 60) || '笔记';
      const relative = `ATLAS/knowledge/${fields.tag || '未分类'}/${name}-${id}.md`;
      const data = parseRecord({
        schemaVersion: 1,
        id,
        createdAt: now,
        updatedAt: now,
        type: 'resource',
        ...fields,
        target: relative,
        location: 'vault',
        noteId: id,
      });
      const source = newNote(data);
      await this.atomic(relative, source, null);
      return { data, path: relative, revision: hash(source) };
    });
  }
  private async milestoneSource(id: string, resourceId?: string) {
    const snapshot = await this.scan();
    const matches = snapshot.entries.filter((e) => e.data.id === id);
    if (matches.length > 1) throw new VaultError('重复 ID，拒绝读写正文', 409);
    const entry = matches[0];
    if (entry?.data.type !== 'milestone') throw new VaultError('节点不存在或无法读取', 409);
    let relative = entry.path;
    let resource: Entry | undefined;
    if (resourceId) {
      const resources = snapshot.entries.filter((e) => e.data.id === resourceId);
      if (!entry.data.resourceIds.includes(resourceId) || resources.length !== 1)
        throw new VaultError('节点的文件绑定已更改，请保留草稿并重新打开详情', 409);
      resource = resources[0];
      const resolved = await this.resolveResource(resourceId);
      if (resolved.location !== 'vault' || !/\.md$/i.test(resolved.target))
        throw new VaultError('节点只能读写 Vault 中绑定的 Markdown');
      relative = resolved.target;
    }
    const absolute = await this.safe(relative);
    if ((await fs.stat(absolute)).size > 5 * 1024 * 1024)
      throw new VaultError('笔记超过 5 MB，请在 Obsidian 中编辑');
    const source = await readText(absolute);
    const note = decodeNote(source);
    if (note && snapshot.entries.filter((e) => e.data.id === note.data.id).length !== 1)
      throw new VaultError('重复 ID，拒绝读写正文', 409);
    if (!resourceId && hash(source) !== entry.revision)
      throw new VaultError('文件已更改，请重新加载正文', 409);
    const match = frontmatter.exec(source);
    const header = match?.index === 0 ? match[0] : source.startsWith('\uFEFF') ? '\uFEFF' : '';
    return { source, relative, note, header, resource };
  }
  async readMilestoneContent(id: string, resourceId?: string): Promise<MilestoneContent> {
    const { source, relative, header } = await this.milestoneSource(id, resourceId);
    return { body: source.slice(header.length), revision: hash(source), path: relative };
  }
  async saveMilestoneContent(
    id: string,
    body: string,
    revision: string,
    resourceId?: string,
  ): Promise<MilestoneContent> {
    return this.serialized(async () => {
      const { source, relative, note, header, resource } = await this.milestoneSource(
        id,
        resourceId,
      );
      if (hash(source) !== revision)
        throw new VaultError('文件已被外部修改，未覆盖你的正文；请保留草稿并重新加载正文', 409);
      const joined =
        header + (header && header !== '\uFEFF' && !header.endsWith('\n') ? '\n' : '') + body;
      const changed = note
        ? updateNote(joined, {
            ...note.data,
            updatedAt: new Date().toISOString(),
          })
        : joined;
      let resourceUpdate: { path: string; source: string; revision: string } | undefined;
      if (resource?.data.type === 'resource' && !resource.data.noteId) {
        const original = await readText(await this.safe(resource.path));
        if (hash(original) !== resource.revision) throw new VaultError('文件绑定已被外部修改', 409);
        resourceUpdate = {
          path: resource.path,
          revision: resource.revision,
          source: updateNote(original, {
            ...resource.data,
            target: relative,
            fingerprint: hash(changed),
            updatedAt: new Date().toISOString(),
          }),
        };
      }
      await this.atomic(relative, changed, revision);
      if (resourceUpdate) {
        try {
          await this.atomic(resourceUpdate.path, resourceUpdate.source, resourceUpdate.revision);
        } catch {
          throw new VaultError(
            '正文已保存，但资源引用更新失败；请保留草稿，重新载入并检查文件绑定',
            409,
          );
        }
      }
      return { body, revision: hash(changed), path: relative };
    });
  }
  async obsidianUrl(relative: string) {
    return 'obsidian://open?path=' + encodeURIComponent(await this.safe(relative));
  }
  async deletePreview(id: string): Promise<DeletePreview> {
    const snapshot = await this.scan();
    const entries = spaceSubtree(snapshot.entries, id).sort(
      (a, b) =>
        deletionLevels[a.data.type as keyof typeof deletionLevels] -
          deletionLevels[b.data.type as keyof typeof deletionLevels] ||
        a.data.createdAt.localeCompare(b.data.createdAt) ||
        a.data.id.localeCompare(b.data.id),
    );
    if (!entries.length) throw new VaultError('工作内容不存在或无法读取，请重新加载', 409);
    const ids = new Set(entries.map((e) => e.data.id));
    const paths = new Set(entries.map((e) => e.path));
    const linkedActuals = snapshot.entries.filter(
      (e) => e.data.type === 'actual' && actualTodoIds(e.data).some((todoId) => ids.has(todoId)),
    );
    const linkedResources = snapshot.entries.filter(
      (e) =>
        e.data.type === 'resource' &&
        ((e.data.noteId && ids.has(e.data.noteId)) ||
          (e.data.location === 'vault' && paths.has(e.data.target.replaceAll('\\', '/')))),
    );
    const blockedReason = snapshot.issues.length
      ? 'Vault 存在诊断，请先处理后再删除：' + snapshot.issues[0].message
      : linkedActuals.length
        ? `这些待办已关联 ${linkedActuals.length} 条实际工作记录，请先到今日编辑对应记录，解除待办关联后再删除。`
        : linkedResources.length
          ? '待删除的 Markdown 本身被资源引用，请先解除对应资源引用后再删除。'
          : null;
    return { entries, blockedReason };
  }
  async deleteSpace(id: string, expectations: Record<string, string>): Promise<DeleteResult> {
    return this.serialized(async () => {
      const preview = await this.deletePreview(id);
      if (preview.blockedReason) throw new VaultError(preview.blockedReason, 409);
      if (
        Object.keys(expectations).length !== preview.entries.length ||
        preview.entries.some((e) => expectations[e.data.id] !== e.revision)
      )
        throw new VaultError('删除范围或文件已更改，请重新检查后再删除', 409);
      for (const entry of preview.entries)
        if (hash(await readText(await this.safe(entry.path))) !== entry.revision)
          throw new VaultError('外部修改冲突，未删除文件', 409);
      const ordered = [...preview.entries].sort(
        (a, b) =>
          deletionLevels[b.data.type as keyof typeof deletionLevels] -
          deletionLevels[a.data.type as keyof typeof deletionLevels],
      );
      const deletedIds: string[] = [];
      try {
        for (const entry of ordered) {
          const target = await this.safe(entry.path);
          if (hash(await readText(target)) !== entry.revision)
            throw new VaultError('外部修改冲突', 409);
          await fs.unlink(target);
          deletedIds.push(entry.data.id);
        }
      } catch (error) {
        throw new VaultError(
          '删除中断，已删除 ' + deletedIds.length + ' 项，其余内容保留。' + String(error),
          409,
        );
      }
      return { deletedIds };
    });
  }
  private async storedBackups() {
    let names: string[];
    try {
      names = await fs.readdir(await this.safe('.atlas/backups'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const results = [];
    for (const name of names.filter((n) => backupName.test(n))) {
      const content = backupSchema.parse(
        JSON.parse(await readText(await this.safe('.atlas/backups/' + name))),
      );
      results.push({ ...content, id: name.slice(0, -5) });
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async backups() {
    return (await this.storedBackups()).map((b) => ({
      id: b.id,
      createdAt: b.createdAt,
      count: b.files.length,
    }));
  }
  async backup() {
    return this.serialized(async () => {
      const snapshot = await this.scan();
      if (snapshot.issues.length) throw new VaultError('索引存在诊断，请先修复后创建快照');
      const files = await Promise.all(
        snapshot.entries.map(async (e) => ({
          path: e.path,
          content: await readText(await this.safe(e.path)),
        })),
      );
      const id = randomUUID();
      await this.atomic(
        '.atlas/backups/' + id + '.json',
        JSON.stringify(
          {
            version: 1,
            createdAt: new Date().toISOString(),
            files,
          },
          null,
          2,
        ),
        null,
      );
      const backups = await this.storedBackups();
      backups.sort((a, b) => Number(b.id === id) - Number(a.id === id));
      for (const old of backups.slice(3))
        await fs.unlink(await this.safe('.atlas/backups/' + old.id + '.json'));
      return { id, count: files.length };
    });
  }
  async restore(id: string, expectations: Record<string, string>) {
    return this.serialized(async () => {
      if (!backupName.test(id + '.json')) throw new VaultError('无效备份 ID');
      const backup = backupSchema.parse(
        JSON.parse(await readText(await this.safe('.atlas/backups/' + id + '.json'))),
      );
      const snapshot = await this.scan();
      const changes: { path: string; content: string; current: string | null }[] = [];
      for (const file of backup.files) {
        const note = decodeNote(file.content);
        if (!note) throw new VaultError('备份包含非 ATLAS 文件');
        const matches = snapshot.entries.filter((e) => e.data.id === note.data.id);
        if (matches.length > 1) throw new VaultError('重复 ID，无法恢复', 409);
        const target = matches[0]?.path ?? file.path;
        let current: string | null = null;
        try {
          current = await readText(await this.safe(target, true));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (
          current !== null &&
          current !== file.content &&
          (!decodeNote(current) || expectations[note.data.id] !== hash(current))
        )
          throw new VaultError('恢复冲突，请刷新并检查当前记录', 409);
        changes.push({ path: target, content: file.content, current });
      }
      for (const change of changes)
        if (change.current !== change.content)
          await this.atomic(
            change.path,
            change.content,
            change.current === null ? null : hash(change.current),
          );
      return { restored: changes.length };
    });
  }
  async resolveResource(id: string) {
    const snapshot = await this.scan();
    const entry = snapshot.entries.find((e) => e.data.id === id);
    if (entry?.data.type !== 'resource') throw new VaultError('资源不存在');
    const resource = entry.data;
    if (resource.location !== 'vault')
      return { target: resource.target, location: resource.location };
    let target = resource.target;
    if (resource.noteId)
      target = snapshot.entries.find((e) => e.data.id === resource.noteId)?.path ?? target;
    try {
      await this.safe(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const candidates = [];
      if (resource.fingerprint)
        for (const f of snapshot.files.filter(
          (f) => !f.directory && path.extname(f.path) === path.extname(target),
        ))
          if (hash(await fs.readFile(await this.safe(f.path))) === resource.fingerprint)
            candidates.push(f.path);
      if (candidates.length !== 1) throw new VaultError('资源已移动且无法唯一定位，请编辑资源路径');
      target = candidates[0];
    }
    return {
      location: 'vault' as const,
      target,
      obsidianUrl: await this.obsidianUrl(target),
      absolute: await this.safe(target),
    };
  }
}
