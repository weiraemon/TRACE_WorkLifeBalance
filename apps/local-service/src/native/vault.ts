import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import { validateChange, type Entry, type Snapshot } from '../../../../packages/domain/index';
import { Workspace } from '../../../../packages/workspace/workspace';
import { VaultError } from '../../../../packages/workspace/errors';
import { changesSchema, type FileChange } from '../../../../packages/workspace/file-change';
import { decodeNote } from '../../../../packages/workspace/markdown';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile);
const lockSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().uuid(),
  host: z.string().optional(),
  hostname: z.string().optional(),
  startedAt: z.string().nullable().optional(),
});
let ownProcessStart: Promise<string | null> | undefined;
async function processStart(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { windowsHide: true, timeout: 5000 },
      );
      return stdout.trim() || null;
    }
    if (process.platform === 'linux') {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      return (
        (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() +
        ':' +
        stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      );
    }
  } catch {}
  return null;
}
function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
async function abandonedLock(source: string, startedAt: string | null, filename: string) {
  let parsed;
  try {
    parsed = lockSchema.safeParse(JSON.parse(source));
  } catch {
    throw new VaultError('进程锁内容损坏，请核实 .atlas 中的锁文件；未自动删除', 409);
  }
  if (!parsed.success)
    throw new VaultError('进程锁内容无法识别，请核实 .atlas 中的锁文件；未自动删除', 409);
  const lock = parsed.data;
  const lockHost = lock.host ?? lock.hostname;
  if (lockHost && lockHost !== hostname())
    throw new VaultError('工作目录的锁来自另一台电脑，请先确认该服务已关闭', 409);
  if (processExists(lock.pid)) {
    const currentStart = lock.pid === process.pid ? startedAt : await processStart(lock.pid);
    const reusedPid = lock.startedAt && currentStart && lock.startedAt !== currentStart;
    const oldLock =
      !lock.startedAt &&
      currentStart &&
      process.platform === 'win32' &&
      Date.parse(currentStart) > (await fs.stat(filename)).mtimeMs + 1000;
    if (!reusedPid && !oldLock && processExists(lock.pid))
      throw new VaultError('Vault 已由一个 ATLAS 服务打开，请关闭该服务后重试', 409);
  }
  return lock;
}
const slash = (value: string) => value.split(path.sep).join('/');
const ignored = new Set(['.git', '.obsidian', '.atlas', 'node_modules']);
const backupSchema = z.object({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  files: z.array(z.object({ path: z.string().min(1), content: z.string() })),
});
const backupName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/;
export async function readText(filename: string) {
  const bytes = await fs.readFile(filename);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new VaultError('笔记不是有效 UTF-8，拒绝修改；请先在原编辑器检查编码');
  }
}

export class Vault extends Workspace {
  readonly sessionId = randomUUID();
  private closing = false;
  private tail: Promise<unknown> = Promise.resolve();
  private lockToken = randomUUID();
  private constructor(public root: string) {
    super();
  }
  private async connectionGuard(owner: string, startedAt: string | null) {
    const relative = '.atlas/service-connecting';
    const guard = await this.safe(relative, true);
    const candidate = await this.safe(`${relative}-${this.lockToken}`, true);
    const filename = `${this.lockToken}.json`;
    await fs.mkdir(candidate);
    let acquired = false;
    try {
      await fs.writeFile(path.join(candidate, filename), owner, { flag: 'wx' });
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Publish a nonempty directory atomically: a late rmdir cannot remove its new owner.
          await fs.rename(candidate, guard);
          acquired = true;
          break;
        } catch (error) {
          if (
            !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
          )
            throw error;
        }
        try {
          const names = await fs.readdir(await this.safe(relative));
          if (names.length) {
            if (names.length !== 1 || !/^[a-f0-9-]{36}\.json$/.test(names[0]))
              throw new VaultError('连接锁内容损坏，请核实 .atlas/service-connecting', 409);
            const file = await this.safe(`${relative}/${names[0]}`);
            const lock = await abandonedLock(await fs.readFile(file, 'utf8'), startedAt, file);
            if (`${lock.token}.json` !== names[0])
              throw new VaultError('连接锁令牌不一致，未自动删除', 409);
            await fs.unlink(file);
          }
          await fs.rmdir(guard);
        } catch (error) {
          if (
            !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')
          )
            throw error;
        }
      }
      if (!acquired) throw new VaultError('工作目录正在被其他服务连接，请稍后重试', 409);
    } finally {
      if (!acquired) {
        await fs.unlink(path.join(candidate, filename)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await fs.rmdir(candidate);
      }
    }
    return async () => {
      await fs.unlink(await this.safe(`${relative}/${filename}`));
      await fs.rmdir(guard).catch((error: NodeJS.ErrnoException) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')) throw error;
      });
    };
  }
  static async open(input: string) {
    if (!path.isAbsolute(input)) throw new VaultError('Vault 需要绝对路径');
    const root = await fs.realpath(input);
    if (!(await fs.stat(root)).isDirectory()) throw new VaultError('Vault 必须是目录');
    const vault = new Vault(root);
    await vault.safe('.atlas', true);
    await fs.mkdir(path.join(root, '.atlas'), { recursive: true });
    const lockPath = await vault.safe('.atlas/service.lock', true);
    const startedAt = await (ownProcessStart ??= processStart(process.pid));
    const owner = JSON.stringify({
      pid: process.pid,
      token: vault.lockToken,
      host: hostname(),
      startedAt,
    });
    let acquired = false;
    const releaseGuard = await vault.connectionGuard(owner, startedAt);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await fs.writeFile(lockPath, owner, { flag: 'wx' });
          acquired = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        try {
          const source = await fs.readFile(await vault.safe('.atlas/service.lock'), 'utf8');
          await abandonedLock(source, startedAt, lockPath);
          // 回收前再次核对，避免移除检查期间其他服务换上的锁。
          if ((await fs.readFile(await vault.safe('.atlas/service.lock'), 'utf8')) !== source)
            continue;
          await fs.unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          if (error instanceof SyntaxError)
            throw new VaultError('进程锁内容损坏，请核实 .atlas/service.lock；未自动删除', 409);
          throw error;
        }
      }
    } finally {
      await releaseGuard();
    }
    if (!acquired) throw new VaultError('工作目录正在被其他服务连接，请稍后重试', 409);
    try {
      await vault.resumeChanges();
      return vault;
    } catch (error) {
      await vault.close();
      throw error;
    }
  }
  async close() {
    this.closing = true;
    await this.tail;
    const lock = await this.safe('.atlas/service.lock');
    const data = JSON.parse(await fs.readFile(lock, 'utf8'));
    if (data.token === this.lockToken) await fs.unlink(lock);
  }
  protected async readSource(relative: string) {
    return readText(await this.safe(relative));
  }
  protected contentHash(source: string) {
    return hash(source);
  }
  protected async resourceFingerprint(relative: string) {
    const target = await this.safe(relative);
    return (await fs.stat(target)).isFile() ? hash(await fs.readFile(target)) : null;
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
  protected serialized<T>(fn: () => Promise<T>): Promise<T> {
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
  protected async atomic(relative: string, content: string, expected: string | null) {
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
  protected async commitChanges(changes: FileChange[]) {
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
  async obsidianUrl(relative: string) {
    return 'obsidian://open?path=' + encodeURIComponent(await this.safe(relative));
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
