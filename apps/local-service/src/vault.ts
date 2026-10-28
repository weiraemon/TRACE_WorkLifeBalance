import fs from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { parseDocument, stringify, isMap } from 'yaml';
import { z } from 'zod';
import { inboxPath, readInboxText, writeInboxText } from './message-store';
import {
  fallbackDestination,
  inboxSchema,
  suggestionSchema,
  type Inbox,
  type MessageDestination,
  type Suggestion,
} from '../../../packages/domain/messages';
import {
  parseRecord,
  validateChange,
  noteInputSchema,
  saveOptionsSchema,
  isSpaceItem,
  localDay,
  type Entry,
  type Snapshot,
  type RecordData,
  type NoteContent,
  type DeletePreview,
  type DeleteResult,
  type SaveOptions,
  type BusinessLine,
  type Milestone,
  type Todo,
} from '../../../packages/domain/index';
import { spaceSubtree, lineFor, spaceParentId } from '../../../packages/domain/workspace';
import {
  appendComment,
  section,
  putSection,
  refreshHeadings,
  unbindSections,
  nodeHeading,
} from './line-notes';

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
const frontmatter = /^(\uFEFF?---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/m;
const backupSchema = z.object({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  files: z.array(z.object({ path: z.string().min(1), content: z.string() })),
});
const backupName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/;
const changesSchema = z
  .array(
    z
      .object({
        path: z.string().min(1),
        expected: z.string().nullable(),
        content: z.string().nullable(),
      })
      .strict(),
  )
  .max(10000);
type FileChange = z.infer<typeof changesSchema>[number];
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
    newline +
    stringify({ managed: true, record: data })
      .trimEnd()
      .split('\n')
      .map((line) => '  ' + line)
      .join(newline) +
    newline;
  const yaml = note.match[2];
  return (
    note.match[1] +
    yaml.slice(0, range[0]).trimEnd() +
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
    await vault.acquireLock();
    try {
      await vault.resumeChanges();
      return vault;
    } catch (error) {
      await vault.close();
      throw error;
    }
  }
  private async acquireLock() {
    const busy = () =>
      new VaultError(
        '工作目录已由一个 CHAOS 服务打开，或无法确认旧锁是否失效。请先关闭其他启动窗口后重试；不要删除仍在使用的锁文件。',
        409,
      );
    const writeLock = async () =>
      fs.writeFile(
        await this.safe('.atlas/service.lock', true),
        JSON.stringify({ pid: process.pid, token: this.lockToken, hostname: hostname() }),
        { flag: 'wx' },
      );
    try {
      await writeLock();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    // Serialize stale-lock recovery so two starters cannot remove each other's new lock.
    const guardPath = await this.safe('.atlas/service-lock-recovery', true);
    let guard;
    try {
      guard = await fs.open(guardPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw busy();
      throw error;
    }
    try {
      const lockPath = await this.safe('.atlas/service.lock', true);
      let contents: string | undefined;
      try {
        contents = await fs.readFile(lockPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (contents !== undefined) {
        let lock;
        try {
          lock = JSON.parse(contents);
        } catch {
          throw busy();
        }
        if (
          !lock ||
          !Number.isSafeInteger(lock.pid) ||
          lock.pid <= 0 ||
          (lock.hostname && lock.hostname !== hostname())
        )
          throw busy();
        try {
          process.kill(lock.pid, 0);
          throw busy();
        } catch (error) {
          // Only ESRCH proves the owner is gone; permission errors are not proof.
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw busy();
        }
        if ((await fs.readFile(lockPath, 'utf8')) !== contents) throw busy();
        await fs.unlink(lockPath);
      }
      try {
        await writeLock();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw busy();
        throw error;
      }
    } finally {
      await guard.close();
      await fs.unlink(guardPath);
    }
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
    const task = this.tail.then(async () => {
      try {
        await fs.access(await this.safe('.atlas/pending.json', true));
        throw new VaultError('有未完成的跨文件操作，请重新连接以恢复；不要重复提交', 409);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return fn();
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async scan(): Promise<Snapshot> {
    // shortcut: full scans suit R0; add an incremental index only after large-Vault measurements.
    const entries: Entry[] = [],
      files: Snapshot['files'] = [],
      issues: Snapshot['issues'] = [];
    try {
      await fs.access(await this.safe('.atlas/pending.json', true));
      issues.push({
        path: '.atlas/pending.json',
        message: '跨文件操作未完成，请重新连接当前目录恢复',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
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
  private async resumeChanges() {
    let changes: FileChange[];
    try {
      changes = changesSchema.parse(
        JSON.parse(await readText(await this.safe('.atlas/pending.json'))),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const current: (string | null)[] = [];
    for (const change of changes) {
      let value: string | null = null;
      try {
        value = hash(await readText(await this.safe(change.path)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (
        value !== change.expected &&
        value !== (change.content === null ? null : hash(change.content))
      )
        throw new VaultError('跨文件操作遇到外部修改，未覆盖文件：' + change.path, 409);
      current.push(value);
    }
    for (const [index, change] of changes.entries()) {
      const finalHash = change.content === null ? null : hash(change.content);
      if (current[index] === finalHash) continue;
      if (change.content === null) {
        const absolute = await this.safe(change.path);
        if (hash(await readText(absolute)) !== change.expected)
          throw new VaultError('删除遇到外部修改', 409);
        await fs.unlink(absolute);
      } else await this.atomic(change.path, change.content, current[index]);
    }
    await fs.unlink(await this.safe('.atlas/pending.json'));
  }
  async recover() {
    if (this.closing) throw new VaultError('工作目录正在关闭', 409);
    const task = this.tail.then(() => this.resumeChanges());
    this.tail = task.catch(() => {});
    return task;
  }
  private async commitChanges(changes: FileChange[]) {
    changesSchema.parse(changes);
    if (!changes.length) return;
    if (new Set(changes.map((c) => c.path)).size !== changes.length)
      throw new VaultError('同一文件不能重复发布');
    // The journal contains intended new content, not per-operation backups or undo history.
    for (const change of changes) {
      let current: string | null = null;
      try {
        current = hash(await readText(await this.safe(change.path)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (current !== change.expected)
        throw new VaultError('文件已更改，未开始操作：' + change.path, 409);
    }
    await this.atomic('.atlas/pending.json', JSON.stringify(changes), null);
    await this.resumeChanges();
  }
  private createLineParts(line: BusinessLine): RecordData[] {
    const now = new Date().toISOString(),
      notesId = randomUUID();
    const relative = `ATLAS/knowledge/业务线/${notesId}.md`;
    const notes = parseRecord({
      schemaVersion: 1,
      id: notesId,
      createdAt: now,
      updatedAt: now,
      type: 'resource',
      title: line.title + ' · Notes',
      target: relative,
      location: 'vault',
      noteId: notesId,
      tag: '业务线',
    });
    const pool = parseRecord({
      schemaVersion: 1,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      type: 'milestone',
      title: '待办池',
      lineId: line.id,
      pool: true,
    });
    return [{ ...line, notesId }, notes, pool];
  }
  private async notesBody(line: BusinessLine, entries: Entry[], bodies: Map<string, string>) {
    if (!line.notesId) throw new VaultError('业务线缺少 Notes，请检查目录诊断', 409);
    if (bodies.has(line.notesId)) return bodies.get(line.notesId)!;
    const matches = entries.filter((e) => e.data.id === line.notesId);
    if (matches.length !== 1) throw new VaultError('Notes 不存在或 ID 重复', 409);
    const note = matches[0];
    if (!note || note.data.type !== 'resource' || note.data.noteId !== note.data.id)
      throw new VaultError('业务线 Notes 不存在或不是专属笔记', 409);
    const source = await readText(await this.safe(note.path));
    if (hash(source) !== note.revision) throw new VaultError('Notes 已被外部修改，请重新加载', 409);
    const header = frontmatter.exec(source);
    const body = source.slice(header?.index === 0 ? header[0].length : 0);
    bodies.set(line.notesId, body);
    return body;
  }
  private async prepareChanges(
    entries: Entry[],
    records: RecordData[],
    bodies = new Map<string, string>(),
  ) {
    const changes: FileChange[] = [];
    const changed = new Map(records.map((r) => [r.id, r]));
    for (const id of bodies.keys()) {
      const data = changed.get(id) ?? entries.find((e) => e.data.id === id)?.data;
      if (!data) throw new VaultError('Notes 不存在', 409);
      changed.set(id, data);
    }
    for (const data of changed.values()) {
      const matches = entries.filter((e) => e.data.id === data.id);
      if (matches.length > 1) throw new VaultError('重复 ID，拒绝发布', 409);
      const existing = matches[0];
      const relative =
        existing?.path ??
        (data.type === 'resource' && data.noteId === data.id
          ? data.target
          : `ATLAS/${data.type}/${data.id}.md`);
      let source = existing ? await readText(await this.safe(relative)) : newNote(data);
      if (existing && hash(source) !== existing.revision)
        throw new VaultError('文件已被外部修改：' + relative, 409);
      source =
        existing && JSON.stringify(existing.data) !== JSON.stringify(data)
          ? updateNote(source, data)
          : source;
      if (bodies.has(data.id)) {
        const match = frontmatter.exec(source);
        if (!match || match.index !== 0) throw new VaultError('Notes 管理字段损坏', 409);
        source = match[0] + bodies.get(data.id);
      }
      if (!existing || hash(source) !== existing.revision)
        changes.push({ path: relative, content: source, expected: existing?.revision ?? null });
    }
    return changes;
  }
  async save(input: unknown, revision?: string, options: SaveOptions = {}): Promise<Entry> {
    return this.serialized(async () => {
      let data = parseRecord(input);
      const settings = saveOptionsSchema.parse(options);
      const snapshot = await this.scan();
      const matches = snapshot.entries.filter((e) => e.data.id === data.id);
      if (matches.length > 1) throw new VaultError('重复 ID，拒绝写入', 409);
      const existing = matches[0];
      if (existing && (revision !== existing.revision || existing.data.type !== data.type))
        throw new VaultError('文件已更改，请重新加载；未覆盖你的编辑', 409);
      if (!existing && revision) throw new VaultError('原记录已移除或无法读取', 409);
      let moveTarget: RecordData | undefined;
      if (settings.move) {
        if (!existing) throw new VaultError('只能移动已有工作对象');
        const target = snapshot.entries.find((e) => e.data.id === settings.move!.targetId);
        if (!target || target.revision !== settings.move.revision)
          throw new VaultError('目标已更改，请重新加载后再移动', 409);
        moveTarget = target.data;
        const inside = settings.move.placement === 'inside';
        if (data.id === moveTarget.id) throw new VaultError('不能移动到自身');
        if (
          data.type === 'workline' &&
          ((inside && moveTarget.type === 'project') || (!inside && moveTarget.type === 'workline'))
        ) {
          data = {
            ...data,
            projectId: moveTarget.type === 'workline' ? moveTarget.projectId : moveTarget.id,
          };
        } else if (
          data.type === 'milestone' &&
          !data.pool &&
          inside &&
          moveTarget.type === 'workline'
        ) {
          data = { ...data, lineId: moveTarget.id };
        } else if (
          data.type === 'todo' &&
          ((inside && moveTarget.type === 'milestone') || (!inside && moveTarget.type === 'todo'))
        ) {
          data = {
            ...data,
            milestoneId: moveTarget.type === 'todo' ? moveTarget.milestoneId : moveTarget.id,
          };
        } else throw new VaultError('不能跨层级移动；待办池固定在线尾');
      }
      if (settings.newItems.length && data.type !== 'actual')
        throw new VaultError('只有实际表单可以同时发布新条目');
      if (
        settings.newItems.some(
          (r) => r.id === data.id || snapshot.entries.some((e) => e.data.id === r.id),
        ) ||
        new Set(settings.newItems.map((r) => r.id)).size !== settings.newItems.length
      )
        throw new VaultError('新条目 ID 已存在或重复', 409);
      const now = new Date().toISOString();
      data = { ...data, createdAt: existing?.data.createdAt ?? data.createdAt, updatedAt: now };
      if (data.type === 'todo' && data.kind === 'todo' && !data.completedAt && data.dueDate) {
        const nodeId = data.milestoneId;
        const node = snapshot.entries.find((e) => e.data.id === nodeId)?.data;
        if (
          node?.type === 'milestone' &&
          !node.pool &&
          node.dueDate &&
          data.dueDate > node.dueDate
        ) {
          const pool = snapshot.entries.find(
            (e) => e.data.type === 'milestone' && e.data.lineId === node.lineId && e.data.pool,
          )?.data;
          if (!pool) throw new VaultError('业务线缺少待办池，请检查目录诊断', 409);
          data = { ...data, milestoneId: pool.id };
        }
      }
      if (settings.completion !== undefined) {
        if (!isSpaceItem(data)) throw new VaultError('此对象不支持完成');
        if (data.type === 'milestone' && data.pool) throw new VaultError('待办池不完成');
        data = { ...data, completedAt: settings.completion ? now : null };
      }
      if (data.type === 'resource' && data.location === 'vault' && data.noteId !== data.id) {
        const targetPath = data.target;
        const target = await this.safe(targetPath),
          stat = await fs.stat(target);
        const note = snapshot.entries.find((e) => e.path === slash(targetPath));
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
        throw new VaultError('笔记路径和标签由创建时确定，请在文件管理器中整理');
      if (
        data.type === 'workline' &&
        existing?.data.type === 'workline' &&
        data.notesId !== existing.data.notesId
      )
        throw new VaultError('业务线使用自己的 Notes');
      if (
        data.type === 'milestone' &&
        data.pool &&
        (!existing ||
          existing.data.type !== 'milestone' ||
          !existing.data.pool ||
          data.lineId !== existing.data.lineId)
      )
        throw new VaultError('待办池由业务线自动创建，不能复制或移动');
      if (
        data.type === 'milestone' &&
        existing?.data.type === 'milestone' &&
        existing.data.pool &&
        !data.pool
      )
        throw new VaultError('不能移除待办池的系统用途');
      const changed = new Map<string, RecordData>();
      if (data.type === 'workline' && !existing) {
        for (const part of this.createLineParts(data)) changed.set(part.id, part);
        data = changed.get(data.id)!;
      } else changed.set(data.id, data);
      if (settings.move && moveTarget && (data.type === 'workline' || data.type === 'todo')) {
        const parentId = spaceParentId(data);
        const siblings = snapshot.entries
          .map((e) => e.data)
          .filter(
            (r): r is BusinessLine | Todo =>
              r.type === data.type && r.id !== data.id && spaceParentId(r) === parentId,
          )
          .sort(
            (a, b) =>
              a.order - b.order ||
              a.createdAt.localeCompare(b.createdAt) ||
              a.id.localeCompare(b.id),
          );
        const index = siblings.findIndex((r) => r.id === moveTarget!.id);
        siblings.splice(
          index < 0 ? siblings.length : index + (settings.move.placement === 'after' ? 1 : 0),
          0,
          data,
        );
        for (const [order, item] of siblings.entries()) {
          if (item.id === data.id) data = { ...data, order };
          if (item.id === data.id || item.order !== order)
            changed.set(item.id, { ...item, order, updatedAt: now });
        }
      }
      for (const item of settings.newItems) changed.set(item.id, parseRecord(item));
      if (data.type === 'actual') {
        const linkedIds = data.itemIds;
        if (
          settings.newItems.some((r) => !linkedIds.includes(r.id)) ||
          settings.completeIds.some((id) => !linkedIds.includes(id))
        )
          throw new VaultError('新条目和本次完成必须关联到这段实际工作');
        for (const id of settings.completeIds) {
          const item = changed.get(id) ?? snapshot.entries.find((e) => e.data.id === id)?.data;
          if (item?.type !== 'todo') throw new VaultError('完成条目不存在');
          changed.set(id, { ...item, completedAt: item.completedAt ?? now, updatedAt: now });
        }
      } else if (settings.completeIds.length) throw new VaultError('本次完成只用于实际工作');
      if (
        data.type === 'milestone' &&
        existing?.data.type === 'milestone' &&
        (settings.completion !== undefined || data.completedAt !== existing.data.completedAt)
      ) {
        const children = snapshot.entries
          .map((e) => e.data)
          .filter((r): r is Todo => r.type === 'todo' && r.milestoneId === data.id);
        for (const child of children)
          changed.set(child.id, { ...child, completedAt: data.completedAt, updatedAt: now });
        if (children.length) {
          data = { ...data, completedAt: null };
          changed.set(data.id, data);
        }
      }
      const virtual = [
        ...snapshot.entries.filter((e) => !changed.has(e.data.id)),
        ...[...changed.values()].map((r) => ({ data: r, path: '', revision: '' })),
      ];
      for (const record of changed.values()) validateChange(record, virtual);
      const bodies = new Map<string, string>();
      for (const part of changed.values())
        if (part.type === 'workline' && !snapshot.entries.some((e) => e.data.id === part.id))
          bodies.set(part.notesId!, '\n# ' + part.title + '\n');
      const pointFor = (item: Todo) =>
        virtual.find((e) => e.data.id === item.milestoneId)?.data as Milestone;
      if (
        existing?.data.type === 'todo' &&
        data.type === 'todo' &&
        existing.data.milestoneId !== data.milestoneId
      ) {
        const oldLine = lineFor(existing.data, snapshot.entries)!;
        const oldBody = await this.notesBody(oldLine, snapshot.entries, bodies);
        const found = section(oldBody, 'item', data.id);
        if (found) {
          bodies.set(oldLine.notesId!, putSection(oldBody, 'item', data.id, null));
          const newLine = lineFor(data, virtual)!;
          let newBody = await this.notesBody(newLine, virtual, bodies);
          const node = pointFor(data),
            parent = section(newBody, 'node', node.id)?.text ?? nodeHeading(node);
          newBody = putSection(
            newBody,
            'node',
            node.id,
            putSection(parent, 'item', data.id, found.text),
          );
          bodies.set(newLine.notesId!, newBody);
        }
      }
      if (
        existing?.data.type === 'milestone' &&
        data.type === 'milestone' &&
        existing.data.lineId !== data.lineId
      ) {
        const oldLine = lineFor(existing.data, snapshot.entries)!,
          newLine = lineFor(data, virtual)!;
        const oldBody = await this.notesBody(oldLine, snapshot.entries, bodies),
          found = section(oldBody, 'node', data.id);
        if (found) {
          bodies.set(oldLine.notesId!, putSection(oldBody, 'node', data.id, null));
          const newBody = await this.notesBody(newLine, virtual, bodies);
          bodies.set(newLine.notesId!, putSection(newBody, 'node', data.id, found.text));
        }
      }
      if (data.type === 'milestone' || data.type === 'todo') {
        const line = lineFor(data, virtual)!;
        const body = await this.notesBody(line, virtual, bodies);
        bodies.set(
          line.notesId!,
          refreshHeadings(
            body,
            data.type === 'todo' ? pointFor(data) : data,
            data.type === 'todo' ? data : undefined,
          ),
        );
      }
      for (const comment of settings.comments) {
        const target = virtual.find((e) => e.data.id === comment.targetId)?.data;
        if (target?.type !== 'milestone' && target?.type !== 'todo')
          throw new VaultError('批注对象不存在');
        const line = lineFor(target, virtual)!;
        const body = await this.notesBody(line, virtual, bodies);
        bodies.set(
          line.notesId!,
          appendComment(
            body,
            target.type === 'todo' ? pointFor(target) : target,
            target.type === 'todo' ? target : undefined,
            { ...comment, date: comment.date ?? (data.type === 'actual' ? data.date : localDay()) },
          ),
        );
      }
      const changes = await this.prepareChanges(snapshot.entries, [...changed.values()], bodies);
      await this.commitChanges(changes);
      const result = (await this.scan()).entries.find((e) => e.data.id === data.id);
      if (!result) throw new VaultError('记录已发布但无法读取，请检查诊断', 409);
      return result;
    });
  }

  async messageInbox() {
    const target = await this.safe(inboxPath, true);
    let source = '';
    try {
      source = await readText(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { state: readInboxText(source), revision: source ? hash(source) : null, source };
  }

  async saveMessageInbox(input: Inbox, revision: string | null) {
    return this.serialized(async () => {
      const current = await this.messageInbox();
      if (current.revision !== revision) throw new VaultError('消息收集已更改，请刷新后重试', 409);
      await this.commitChanges([
        {
          path: inboxPath,
          content: writeInboxText(current.source, inboxSchema.parse(input)),
          expected: revision,
        },
      ]);
    });
  }

  async acceptMessage(
    id: string,
    revision: string | null,
    lineId: string,
    input: Suggestion,
    projectId: string | null = null,
  ) {
    return this.serialized(async () => {
      const inbox = await this.messageInbox();
      if (revision !== inbox.revision) throw new VaultError('消息收集已更改，请刷新后重试', 409);
      const candidate = inbox.state.candidates.find((c) => c.id === id);
      if (!candidate) throw new VaultError('事项已处理或不存在', 409);
      const suggestion = suggestionSchema.parse(input);
      if (suggestion.kind === 'change' || suggestion.kind === 'cancel') {
        const targetId = suggestion.targetId ?? candidate.suggestion.targetId;
        if (!targetId) throw new VaultError('未找到要修改的现有事项，请到工作空间核对');
        const target = (await this.scan()).entries.find((e) => e.data.id === targetId)?.data;
        if (!target || (target.type !== 'milestone' && target.type !== 'todo'))
          throw new VaultError('要修改的事项已不存在或类型不支持');
        if (target.completedAt) throw new VaultError('要修改的事项已完成，请刷新');
        const now = new Date().toISOString();
        const records: RecordData[] = [];
        if (suggestion.kind === 'change') {
          if (suggestion.completed) {
            records.push({ ...target, completedAt: now, updatedAt: now });
            if (target.type === 'milestone') {
              const snapshot = await this.scan();
              for (const { data } of snapshot.entries)
                if (data.type === 'todo' && data.milestoneId === target.id && !data.completedAt)
                  records.push({ ...data, completedAt: now, updatedAt: now });
            }
          } else if (target.type === 'milestone') {
            records.push({
              ...target,
              dueDate: suggestion.dueDate,
              dueTime: suggestion.dueTime,
              location: suggestion.location ?? target.location,
              updatedAt: now,
            });
          } else {
            if (suggestion.dueTime)
              throw new VaultError('待办没有独立时刻，请修改所属节点或先升为节点');
            records.push({ ...target, dueDate: suggestion.dueDate, updatedAt: now });
          }
        } else {
          records.push({ ...target, completedAt: now, updatedAt: now });
          if (target.type === 'milestone') {
            const snapshot = await this.scan();
            for (const { data } of snapshot.entries)
              if (data.type === 'todo' && data.milestoneId === target.id && !data.completedAt)
                records.push({ ...data, completedAt: now, updatedAt: now });
          }
        }
        const snapshot = await this.scan();
        inbox.state.candidates = inbox.state.candidates.filter((c) => c.id !== id);
        const changes = await this.prepareChanges(snapshot.entries, records);
        changes.push({
          path: inboxPath,
          content: writeInboxText(inbox.source, inbox.state),
          expected: inbox.revision,
        });
        await this.commitChanges(changes);
        return { ids: records.map((record) => record.id) };
      }
      if (!['task', 'event'].includes(candidate.suggestion.kind))
        throw new VaultError('事项类型已变化，请刷新后重试');
      const snapshot = await this.scan();
      const now = new Date().toISOString();
      const make = (type: string, fields: object) =>
        parseRecord({
          schemaVersion: 1,
          id: randomUUID(),
          createdAt: now,
          updatedAt: now,
          type,
          ...fields,
        });
      const records: RecordData[] = [];
      const bodies = new Map<string, string>();
      const catalog = snapshot.entries.flatMap(({ data: p }) =>
        p.type === 'project' && !p.completedAt
          ? [
              {
                id: p.id,
                title: p.title,
                lines: snapshot.entries.flatMap(({ data: l }) =>
                  l.type === 'workline' && l.projectId === p.id && !l.completedAt
                    ? [{ id: l.id, title: l.title }]
                    : [],
                ),
              },
            ]
          : [],
      );
      let target: MessageDestination | null = suggestion.destination ?? null;
      const scopedId = projectId ?? candidate.projectId;
      const scopedProject = scopedId ? catalog.find((p) => p.id === scopedId) : undefined;
      if (scopedId && !scopedProject)
        throw new VaultError('会话限定项目已删除或结束，无法创建业务线');
      const scopeCatalog = scopedProject ? [scopedProject] : catalog;
      if (scopedProject && target?.kind === 'newProject')
        target = {
          kind: 'newLine',
          projectId: scopedProject.id,
          lineTitle: target.lineTitle,
          reason: target.reason,
        };
      const lineAvailable = (id: string) => {
        const entry = snapshot.entries.find((e) => e.data.id === id && e.data.type === 'workline');
        if (!entry) return false;
        const data = entry.data;
        if (data.type !== 'workline' || data.completedAt) return false;
        const parent = snapshot.entries.find((e) => e.data.id === data.projectId);
        return Boolean(parent && parent.data.type === 'project' && !parent.data.completedAt);
      };
      if (lineId && !lineAvailable(lineId)) lineId = '';
      if (
        lineId &&
        scopedProject &&
        !scopeCatalog.some((p) => p.lines.some((l) => l.id === lineId))
      )
        lineId = '';
      if (!lineId) {
        const current = target;
        const stale =
          current == null ||
          (current.kind === 'existing' &&
            !scopeCatalog.some((p) => p.lines.some((l) => l.id === current.lineId))) ||
          (current.kind === 'newLine' && !scopeCatalog.some((p) => p.id === current.projectId));
        if (stale)
          target = fallbackDestination(
            suggestion.title,
            candidate.source.text,
            scopeCatalog,
            scopedProject?.id ?? null,
          );
      }
      if (!lineId && target?.kind === 'existing') lineId = target.lineId;
      if (!lineId && target && target.kind !== 'existing') {
        const normalize = (s: string) => s.normalize('NFKC').trim().toLowerCase();
        const cleanTitle = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
        const projectTitle = target.kind === 'newProject' ? cleanTitle(target.projectTitle) : '';
        const lineTitle = cleanTitle(target.lineTitle);
        if (!lineTitle) throw new VaultError('推荐业务线名称无效，请手动填写');
        if (target.kind === 'newProject' && !projectTitle)
          throw new VaultError('推荐项目名称无效，请手动填写');
        let projectId = target.kind === 'newLine' ? target.projectId : '';
        if (target.kind === 'newProject') {
          const matches = snapshot.entries.filter(
            (e) =>
              e.data.type === 'project' &&
              !e.data.completedAt &&
              normalize(e.data.title) === normalize(projectTitle),
          );
          if (matches.length > 1) throw new VaultError('同名项目不唯一，请手动选择业务线');
          if (matches.length) projectId = matches[0].data.id;
          else {
            const project = make('project', { title: projectTitle });
            records.push(project);
            projectId = project.id;
          }
        }
        const parent = [...snapshot.entries.map((e) => e.data), ...records].find(
          (r) => r.id === projectId,
        );
        if (parent?.type !== 'project' || parent.completedAt)
          throw new VaultError('推荐项目已删除或结束，请重新选择归属');
        const matches = snapshot.entries.filter(
          (e) =>
            e.data.type === 'workline' &&
            !e.data.completedAt &&
            e.data.projectId === projectId &&
            normalize(e.data.title) === normalize(lineTitle),
        );
        if (matches.length > 1) throw new VaultError('同名业务线不唯一，请手动选择');
        if (matches.length) lineId = matches[0].data.id;
        else {
          const parts = this.createLineParts(
            make('workline', { title: lineTitle, projectId }) as BusinessLine,
          );
          records.push(...parts);
          const newLine = parts[0] as BusinessLine;
          lineId = newLine.id;
          bodies.set(newLine.notesId!, '\n# ' + newLine.title + '\n');
        }
      }
      const working = [
        ...snapshot.entries,
        ...records.map((data) => ({ data, path: '', revision: '' })),
      ];
      const lines = working.filter((e) => e.data.id === lineId);
      const line = lines.length === 1 ? lines[0].data : undefined;
      const project =
        line?.type === 'workline'
          ? working.find((e) => e.data.id === line.projectId)?.data
          : undefined;
      if (
        line?.type !== 'workline' ||
        line.completedAt ||
        project?.type !== 'project' ||
        project.completedAt
      )
        throw new VaultError('请选择未结束项目中的业务线');
      const pools = working.filter(
        (e) => e.data.type === 'milestone' && e.data.lineId === lineId && e.data.pool,
      );
      if (pools.length !== 1) throw new VaultError('业务线待办池缺失或重复');
      let node = pools[0].data as Milestone;
      if (suggestion.kind === 'event' || suggestion.dueDate) {
        node = make('milestone', {
          title: suggestion.title,
          lineId,
          dueDate: suggestion.dueDate,
          dueTime: suggestion.dueTime,
          tags: suggestion.tags,
          location: suggestion.location,
        }) as Milestone;
        records.push(node);
      }
      const titles = suggestion.actions.length
        ? suggestion.actions
        : suggestion.kind === 'task'
          ? [suggestion.title]
          : [];
      for (const title of titles)
        records.push(
          make('todo', {
            title,
            milestoneId: node.id,
            dueDate: node.pool ? suggestion.dueDate : null,
          }),
        );
      const virtual = [
        ...snapshot.entries,
        ...records.map((data) => ({ data, path: '', revision: '' })),
      ];
      for (const record of records) validateChange(record, virtual);
      const original = await this.notesBody(line, snapshot.entries, bodies);
      // Keep source text once, attached to the node (or the first pool TODO).
      const quote = (value: string) =>
        value
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .split(/\r?\n/)
          .map((s) => '> ' + s)
          .join('\n');
      const source = candidate.source;
      const label = (value: string) =>
        value
          .replace(/[\r\n]+/g, ' ')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
      const location = suggestion.location ? `地点：${label(suggestion.location)}\n\n` : '';
      const text = `QQ · ${label(candidate.conversation)} · ${label(source.sender)} · ${source.sentAt}\n\n${location}${quote(source.text)}${source.context ? '\n\n相关上下文：\n' + quote(source.context) : ''}`;
      bodies.set(
        line.notesId!,
        appendComment(
          original,
          node,
          node.pool ? (records.find((r) => r.type === 'todo') as Todo) : undefined,
          {
            id: candidate.id,
            text,
            date: localDay(),
          },
        ),
      );
      inbox.state.candidates = inbox.state.candidates.filter((c) => c.id !== id);
      const changes = await this.prepareChanges(snapshot.entries, records, bodies);
      changes.push({
        path: inboxPath,
        content: writeInboxText(inbox.source, inbox.state),
        expected: inbox.revision,
      });
      await this.commitChanges(changes);
      return { ids: records.map((r) => r.id) };
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
  private async contentSource(id: string) {
    const snapshot = await this.scan();
    const matches = snapshot.entries.filter((e) => e.data.id === id);
    if (matches.length !== 1 || !isSpaceItem(matches[0].data))
      throw new VaultError('工作对象不存在或 ID 重复', 409);
    const item = matches[0].data;
    const line = lineFor(item, snapshot.entries);
    if (!line?.notesId) throw new VaultError('此对象没有业务线 Notes', 409);
    const notes = snapshot.entries.filter((e) => e.data.id === line.notesId);
    if (notes.length !== 1) throw new VaultError('Notes 不存在或 ID 重复', 409);
    const note = notes[0];
    if (!note || note.data.type !== 'resource' || note.data.noteId !== note.data.id)
      throw new VaultError('Notes 不存在', 409);
    const source = await readText(await this.safe(note.path));
    if (hash(source) !== note.revision) throw new VaultError('Notes 已被外部修改，请重新加载', 409);
    const header = frontmatter.exec(source);
    if (!header || header.index !== 0) throw new VaultError('Notes 管理字段损坏');
    return { source, note, item, header: header[0], body: source.slice(header[0].length) };
  }
  async readContent(id: string): Promise<NoteContent> {
    const { source, note, item, body } = await this.contentSource(id);
    const text =
      item.type === 'workline'
        ? body
        : (section(body, item.type === 'todo' ? 'item' : 'node', item.id)?.text ?? '');
    return { body: text, revision: hash(source), path: note.path };
  }
  async saveContent(id: string, body: string, revision: string): Promise<NoteContent> {
    return this.serialized(async () => {
      const current = await this.contentSource(id);
      if (current.item.type !== 'workline')
        throw new VaultError('请在业务线 Notes 中编辑全文，条目使用添加批注');
      if (hash(current.source) !== revision)
        throw new VaultError('文件已被外部修改，未覆盖正文；请保留草稿并重新加载', 409);
      await this.commitChanges([
        { path: current.note.path, expected: revision, content: current.header + body },
      ]);
      return { body, revision: hash(current.header + body), path: current.note.path };
    });
  }
  async promote(id: string, revision: string): Promise<Entry> {
    return this.serialized(async () => {
      const snapshot = await this.scan(),
        matches = snapshot.entries.filter((e) => e.data.id === id);
      if (matches.length > 1) throw new VaultError('重复 ID，拒绝升线', 409);
      const entry = matches[0];
      if (!entry) throw new VaultError('升线对象不存在', 409);
      if (entry.data.type === 'workline') return entry;
      if (entry.revision !== revision) throw new VaultError('对象已更改，请重新加载后升线', 409);
      const item = entry.data;
      if (item.type !== 'todo' && item.type !== 'milestone')
        throw new VaultError('只有节点、TODO、IDEA可升为业务线');
      if (item.type === 'milestone' && item.pool) throw new VaultError('待办池不能升级');
      const oldLine = lineFor(item, snapshot.entries)!;
      const line = parseRecord({
        schemaVersion: 1,
        id: item.id,
        createdAt: item.createdAt,
        updatedAt: new Date().toISOString(),
        type: 'workline',
        title: item.title,
        importance: item.importance,
        projectId: oldLine.projectId,
        resourceIds: item.resourceIds,
      }) as BusinessLine;
      const parts = this.createLineParts(line);
      const newLine = parts[0] as BusinessLine,
        pool = parts.find((r) => r.type === 'milestone') as Milestone;
      // A scheduled commitment remains a real node, rather than losing its deadline on promotion.
      const destination =
        item.type === 'milestone' && (item.dueDate || item.tags.length)
          ? { ...item, id: randomUUID(), lineId: newLine.id, resourceIds: [] }
          : pool;
      if (destination !== pool) parts.push(destination);
      const bodies = new Map<string, string>();
      const oldBody = await this.notesBody(oldLine, snapshot.entries, bodies);
      const kind = item.type === 'todo' ? 'item' : 'node';
      const found = section(oldBody, kind, item.id);
      bodies.set(oldLine.notesId!, putSection(oldBody, kind, item.id, null));
      let newBody = '\n# ' + line.title + '\n';
      if (found) {
        if (item.type === 'todo') newBody += '\n' + found.text.replace(/^###/, '##') + '\n';
        else
          newBody = putSection(
            newBody,
            'node',
            destination.id,
            destination === pool
              ? nodeHeading(pool) +
                  '\n\n' +
                  nodeHeading(item).replace(/^## /, '') +
                  '\n\n' +
                  found.text.replace(/^##[^\r\n]*(?:\r?\n|$)/, '')
              : found.text,
          );
      }
      bodies.set(newLine.notesId!, newBody);
      if (item.type === 'milestone')
        for (const { data } of snapshot.entries)
          if (data.type === 'todo' && data.milestoneId === item.id)
            parts.push({ ...data, milestoneId: destination.id });
      for (const { data } of snapshot.entries)
        if (
          data.type === 'actual' &&
          (data.itemIds.includes(item.id) || data.milestoneIds.includes(item.id))
        )
          parts.push({
            ...data,
            itemIds: data.itemIds.filter((target) => target !== item.id),
            milestoneIds: data.milestoneIds.filter((target) => target !== item.id),
          });
      const virtual = [
        ...snapshot.entries.filter((e) => !parts.some((r) => r.id === e.data.id)),
        ...parts.map((data) => ({ data, path: '', revision: '' })),
      ];
      for (const data of parts) validateChange(data, virtual);
      await this.commitChanges(await this.prepareChanges(snapshot.entries, parts, bodies));
      return (await this.scan()).entries.find((e) => e.data.id === id)!;
    });
  }

  async obsidianUrl(relative: string) {
    return 'obsidian://open?path=' + encodeURIComponent(await this.safe(relative));
  }
  async deletePreview(id: string): Promise<DeletePreview> {
    const snapshot = await this.scan();
    const entries = spaceSubtree(snapshot.entries, id);
    if (!entries.length) throw new VaultError('工作内容不存在或无法读取', 409);
    const root = entries.find((e) => e.data.id === id)!.data;
    const blockedReason = snapshot.issues.length
      ? '工作目录存在诊断，请先处理：' + snapshot.issues[0].message
      : root.type === 'milestone' && root.pool
        ? '待办池随业务线保留，不能单独删除'
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
      const snapshot = await this.scan(),
        ids = new Set(preview.entries.map((e) => e.data.id));
      const paths = new Set(preview.entries.map((e) => e.path));
      const brokenResources = snapshot.entries.filter(
        (e) =>
          e.data.type === 'resource' &&
          ((e.data.noteId && ids.has(e.data.noteId)) ||
            (e.data.location === 'vault' && paths.has(e.data.target.replaceAll('\\', '/')))),
      );
      for (const e of brokenResources) ids.add(e.data.id);
      const records: RecordData[] = [],
        bodies = new Map<string, string>();
      for (const { data } of snapshot.entries) {
        if (ids.has(data.id)) continue;
        if (
          data.type === 'actual' &&
          [...data.itemIds, ...data.milestoneIds].some((target) => ids.has(target))
        )
          records.push({
            ...data,
            itemIds: data.itemIds.filter((target) => !ids.has(target)),
            milestoneIds: data.milestoneIds.filter((target) => !ids.has(target)),
          });
        if (isSpaceItem(data) && data.resourceIds.some((target) => ids.has(target)))
          records.push({
            ...data,
            resourceIds: data.resourceIds.filter((target) => !ids.has(target)),
          });
        if (data.type === 'workline') {
          const body = await this.notesBody(data, snapshot.entries, bodies);
          bodies.set(data.notesId!, unbindSections(body, ids));
        }
      }
      // The text survives even when deleting its former business line.
      for (const { data } of preview.entries)
        if (data.type === 'workline') {
          const body = await this.notesBody(data, snapshot.entries, bodies);
          bodies.set(data.notesId!, unbindSections(body, ids));
        }
      const changes = await this.prepareChanges(snapshot.entries, records, bodies);
      for (const entry of [...preview.entries, ...brokenResources])
        changes.push({ path: entry.path, expected: entry.revision, content: null });
      await this.commitChanges(changes);
      return { deletedIds: [...ids] };
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
