import { Workspace } from '../../../packages/workspace/workspace';
import { decodeNote } from '../../../packages/workspace/markdown';
import { changesSchema, type FileChange } from '../../../packages/workspace/file-change';
import { validateChange, type Entry, type Snapshot } from '../../../packages/domain/index';

export type NativeCall = <T>(method: string, input?: unknown) => Promise<T>;
export type DirectorySession = { root: string; vaultId: string };
type ScannedFile = {
  path: string;
  directory: boolean;
  source?: string;
  revision?: string;
  error?: string;
};

// This adapter supplies persistence only. Every work operation is inherited unchanged.
export class AndroidWorkspace extends Workspace {
  private tail: Promise<unknown> = Promise.resolve();
  private lastScan?: { fingerprint: string; snapshot: Snapshot };
  private scannedFiles?: ScannedFile[];
  private sources = new Map<string, string>();
  private publishedSnapshot?: Snapshot;
  takePublishedSnapshot() {
    const snapshot = this.publishedSnapshot;
    this.publishedSnapshot = undefined;
    return snapshot;
  }
  constructor(
    readonly directory: DirectorySession,
    readonly native: NativeCall,
    private readonly report?: (phase: string, completed?: number, total?: number) => void,
  ) {
    super();
  }
  override async progress(phase: string, completed: number, total: number) {
    this.report?.(phase, completed, total);
    if (completed % 20 === 0 || completed === total)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
  protected serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.sources.clear();
      try {
        return await fn();
      } finally {
        this.sources.clear();
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  protected call<T>(method: string, input: object = {}) {
    return this.native<T>(method, { ...input, vaultId: this.directory.vaultId });
  }
  async scan(): Promise<Snapshot> {
    this.publishedSnapshot = undefined;
    const files = await this.call<ScannedFile[]>('scan');
    this.scannedFiles = files;
    this.sources = new Map(
      files.flatMap((file) => (file.source === undefined ? [] : [[file.path, file.source]])),
    );
    return this.decodeFiles(files);
  }
  private async decodeFiles(files: ScannedFile[]): Promise<Snapshot> {
    const fingerprint = JSON.stringify(
      files.map(({ path, directory, revision, error }) => [path, directory, revision, error]),
    );
    if (this.lastScan?.fingerprint === fingerprint) return this.lastScan.snapshot;
    const entries: Entry[] = [];
    const issues: Snapshot['issues'] = [];
    for (const [index, file] of files.entries()) {
      if (index % 20 === 0) await this.progress('正在解析工作目录', index, files.length);
      try {
        if (file.error) throw new Error(file.error);
        if (file.source === undefined) continue;
        const note = decodeNote(file.source);
        if (note) entries.push({ data: note.data, path: file.path, revision: file.revision! });
      } catch (error) {
        issues.push({
          path: file.path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.data.id, (counts.get(entry.data.id) ?? 0) + 1);
    for (const [index, entry] of entries.entries()) {
      if (index % 20 === 0) await this.progress('正在检查记录与关联', index, entries.length);
      if (counts.get(entry.data.id)! > 1)
        issues.push({
          path: entry.path,
          message: '重复 ID：' + entry.data.id + '；已禁止写入这些记录',
        });
      try {
        validateChange(entry.data, entries);
      } catch (error) {
        issues.push({ path: entry.path, message: '关联或时间诊断：' + String(error) });
      }
    }
    const snapshot = {
      ...this.directory,
      entries,
      files: files.map(({ path, directory }) => ({ path, directory })),
      issues,
    };
    this.lastScan = { fingerprint, snapshot };
    return snapshot;
  }
  protected async readSource(path: string) {
    // A scan already read and hashed these exact bytes. Publication checks their revisions again.
    const scanned = this.sources.get(path);
    if (scanned !== undefined) return scanned;
    const source = await this.call<string>('read', { path });
    if (
      this.publishedSnapshot &&
      this.scannedFiles?.find((file) => file.path === path)?.revision !==
        (await this.contentHash(source))
    )
      this.publishedSnapshot = undefined;
    return source;
  }
  protected async contentHash(source: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
      '',
    );
  }
  protected resourceFingerprint(path: string) {
    return this.call<string | null>('fingerprint', { path });
  }
  protected atomic(path: string, content: string, expected: string | null) {
    return this.commitChanges([{ path, content, expected }]);
  }
  protected async commitChanges(changes: FileChange[]) {
    const parsed = changesSchema.parse(changes);
    this.publishedSnapshot = undefined;
    this.sources.clear();
    if (!parsed.length) return;
    await this.call('commit', { changes: parsed });
    if (!this.scannedFiles) return;
    const files = new Map(this.scannedFiles.map((file) => [file.path, file]));
    for (const change of parsed) {
      const parts = change.path.split('/');
      if (
        parts.some(
          (part) =>
            ['.git', '.obsidian', '.atlas', 'node_modules'].includes(part) ||
            part.startsWith('.chaos-'),
        )
      )
        continue;
      if (change.content === null) files.delete(change.path);
      else {
        files.set(change.path, {
          path: change.path,
          directory: false,
          ...(change.path.toLowerCase().endsWith('.md')
            ? { source: change.content, revision: await this.contentHash(change.content) }
            : {}),
        });
        for (let depth = 1; depth < parts.length; depth++) {
          const path = parts.slice(0, depth).join('/');
          if (!files.has(path)) files.set(path, { path, directory: true });
        }
      }
    }
    this.scannedFiles = [...files.values()];
    this.publishedSnapshot = await this.decodeFiles(this.scannedFiles);
  }
  backups() {
    return this.serialized(() =>
      this.call<{ id: string; createdAt: string; count: number }[]>('backups'),
    );
  }
  backup() {
    return this.serialized(async () => {
      const snapshot = await this.scan();
      if (snapshot.issues.length) throw new Error('工作目录存在诊断，请先检查再创建快照');
      return this.call<{ count: number }>('backup', {
        entries: snapshot.entries.map(({ path, revision }) => ({ path, revision })),
      });
    });
  }
  restore(id: string, expectations: Record<string, string>) {
    return this.serialized(async () => {
      const snapshot = await this.scan();
      if (snapshot.issues.length) throw new Error('工作目录存在诊断，停止恢复');
      for (const entry of snapshot.entries)
        if (expectations[entry.data.id] !== entry.revision)
          throw new Error('文件已更改，请重新加载后恢复');
      const files = await this.call<{ path: string; content: string }[]>('readBackup', { id });
      const changes: FileChange[] = [];
      for (const file of files) {
        const note = decodeNote(file.content);
        if (!note) throw new Error('备份包含非受管 Markdown，停止恢复');
        const matches = snapshot.entries.filter((entry) => entry.data.id === note.data.id);
        if (matches.length > 1) throw new Error('重复 ID，停止恢复');
        const target = matches[0]?.path ?? file.path;
        const revision = await this.resourceFingerprint(target);
        const current = matches[0];
        if (revision !== null && (!current || revision !== current.revision))
          throw new Error('恢复遇到未确认的文件：' + file.path);
        changes.push({ path: target, content: file.content, expected: revision });
      }
      await this.commitChanges(changes);
      return { restored: changes.length };
    });
  }
  open(id: string) {
    return this.serialized(async () => {
      const snapshot = await this.scan();
      const entry = snapshot.entries.find((entry) => entry.data.id === id);
      if (entry?.data.type !== 'resource') throw new Error('资源不存在');
      const resource = entry.data;
      if (resource.location === 'external')
        throw new Error('此资料位于其他设备，请在手机目录中提供可访问的资料');
      const note = resource.noteId
        ? snapshot.entries.find((entry) => entry.data.id === resource.noteId)
        : undefined;
      await this.call('open', {
        target: note?.path ?? resource.target,
        location: resource.location,
      });
      return {};
    });
  }
  exportDirectory() {
    return this.serialized(() => this.call('export'));
  }
}
