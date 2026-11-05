import {
  parseRecord,
  createRecord,
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
  type SpaceItem,
  type BusinessLine,
  type Milestone,
  type Todo,
} from '../domain/index';
import { spaceSubtree, lineFor, spaceParentId, canPromote } from '../domain/workspace';
import {
  appendComment,
  section,
  putSection,
  refreshHeadings,
  unbindSections,
  nodeHeading,
  displayNotes,
  editableSection,
  replaceContent,
} from './line-notes';

import { VaultError } from './errors';
import type { FileChange } from './file-change';
import { decodeNote, frontmatter, newNote, updateNote } from './markdown';
import { layoutPath, layoutSource, recordPath, checkRelocationLinks } from './layout';

// Platform adapters implement file safety and publication; business rules stay here.
export abstract class Workspace {
  private indexedSnapshot?: Snapshot;
  private publishedSnapshot?: Snapshot;
  protected rememberSnapshot(snapshot: Snapshot) {
    this.indexedSnapshot = snapshot;
    this.publishedSnapshot = undefined;
    return snapshot;
  }
  protected currentSnapshot(): Promise<Snapshot> {
    return this.indexedSnapshot ? Promise.resolve(this.indexedSnapshot) : this.scan();
  }
  protected invalidateIndex() {
    this.indexedSnapshot = undefined;
    this.publishedSnapshot = undefined;
  }
  takePublishedSnapshot() {
    const snapshot = this.publishedSnapshot;
    this.publishedSnapshot = undefined;
    return snapshot;
  }
  async progress(_phase: string, _completed: number, _total: number): Promise<void> {}
  abstract scan(): Promise<Snapshot>;
  snapshot(refresh = true): Promise<Snapshot> {
    return this.serialized(() => (refresh ? this.scan() : this.currentSnapshot()));
  }
  protected abstract readSource(relative: string): Promise<string>;
  protected abstract contentHash(source: string): string | Promise<string>;
  protected abstract resourceFingerprint(relative: string): Promise<string | null>;
  protected abstract serialized<T>(fn: () => Promise<T>): Promise<T>;
  protected abstract atomic(
    relative: string,
    content: string,
    expected: string | null,
  ): Promise<void>;
  protected abstract persistChanges(changes: FileChange[]): Promise<void>;
  protected async commitChanges(changes: FileChange[]) {
    this.publishedSnapshot = undefined;
    try {
      if (
        changes.length &&
        this.indexedSnapshot &&
        !this.indexedSnapshot.files.some((file) => file.path === layoutPath) &&
        this.indexedSnapshot.entries.every((entry) => entry.path === recordPath(entry.data.id)) &&
        !changes.some((change) => change.path === layoutPath)
      )
        changes = [...changes, { path: layoutPath, content: layoutSource, expected: null }];
      await this.persistChanges(changes);
      const snapshot = this.indexedSnapshot;
      if (!snapshot || snapshot.issues.length) {
        this.invalidateIndex();
        return;
      }
      const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
      const files = new Map(snapshot.files.map((file) => [file.path, file]));
      for (const change of changes) {
        const parts = change.path.split('/');
        if (
          parts.some(
            (part) =>
              ['.git', '.obsidian', '.atlas', 'node_modules'].includes(part) ||
              part.startsWith('.chaos-'),
          )
        )
          continue;
        entries.delete(change.path);
        if (change.content === null) files.delete(change.path);
        else {
          files.set(change.path, { path: change.path, directory: false });
          for (let depth = 1; depth < parts.length; depth++) {
            const path = parts.slice(0, depth).join('/');
            files.set(path, { path, directory: true });
          }
          if (change.path.toLowerCase().endsWith('.md')) {
            const note = decodeNote(change.content);
            if (note)
              entries.set(change.path, {
                data: note.data,
                path: change.path,
                revision: await this.contentHash(change.content),
              });
          }
        }
      }
      const next = {
        ...snapshot,
        entries: [...entries.values()],
        files: [...files.values()],
        issues: [] as Snapshot['issues'],
      };
      for (const entry of next.entries) {
        try {
          validateChange(entry.data, next.entries);
        } catch (error) {
          next.issues.push({ path: entry.path, message: '关联或时间诊断：' + String(error) });
        }
      }
      this.rememberSnapshot(next);
      this.publishedSnapshot = next;
    } catch (error) {
      this.invalidateIndex();
      throw error;
    }
  }
  private async recordBody(entry: Entry) {
    const source = await this.readSource(entry.path);
    if ((await this.contentHash(source)) !== entry.revision)
      throw new VaultError('文件已被外部修改，请重新加载', 409);
    const match = frontmatter.exec(source);
    if (!match || match.index !== 0) throw new VaultError('管理字段损坏', 409);
    return source.slice(match[0].length);
  }
  async readManaged() {
    return this.serialized(async () => {
      const snapshot = await this.scan();
      if (snapshot.issues.length) throw new VaultError('工作目录存在诊断，请先处理后再交换', 409);
      const items = [];
      for (const [index, entry] of snapshot.entries.entries()) {
        await this.progress('正在读取并校验正文', index, snapshot.entries.length);
        items.push({ data: entry.data, body: await this.recordBody(entry) });
      }
      return { snapshot, items };
    });
  }
  private completionChanges(
    item: SpaceItem,
    records: RecordData[],
    at: string | null,
    now: string,
  ): SpaceItem[] {
    if (item.type === 'milestone' && item.pool) throw new VaultError('待办池不完成');
    const update = (record: SpaceItem): SpaceItem => ({
      ...record,
      completedAt: at === null ? null : (record.completedAt ?? at),
      updatedAt: now,
    });
    const children =
      item.type === 'milestone'
        ? records.filter(
            (record): record is Todo => record.type === 'todo' && record.milestoneId === item.id,
          )
        : [];
    return [
      ...children.map(update),
      { ...update(item), ...(children.length ? { completedAt: null } : {}) },
    ];
  }
  private createLineParts(line: BusinessLine): RecordData[] {
    const now = new Date().toISOString(),
      notesId = crypto.randomUUID();
    const relative = recordPath(notesId);
    const notes = createRecord(
      'resource',
      {
        id: notesId,
        title: line.title + ' · Notes',
        target: relative,
        location: 'vault',
        noteId: notesId,
        tag: '业务线',
      },
      now,
    );
    const pool = createRecord(
      'milestone',
      {
        title: '待办池',
        lineId: line.id,
        pool: true,
      },
      now,
    );
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
    const source = await this.readSource(note.path);
    if ((await this.contentHash(source)) !== note.revision)
      throw new VaultError('Notes 已被外部修改，请重新加载', 409);
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
      await this.progress('正在准备写入文件', changes.length, changed.size);
      const matches = entries.filter((e) => e.data.id === data.id);
      if (matches.length > 1) throw new VaultError('重复 ID，拒绝发布', 409);
      const existing = matches[0];
      const relative =
        existing?.path ??
        (data.type === 'resource' && data.noteId === data.id ? data.target : recordPath(data.id));
      let source = existing ? await this.readSource(relative) : newNote(data);
      if (existing && (await this.contentHash(source)) !== existing.revision) {
        this.invalidateIndex();
        throw new VaultError('文件已更改，检测到外部修改：' + relative, 409);
      }
      source =
        existing && JSON.stringify(existing.data) !== JSON.stringify(data)
          ? updateNote(source, data)
          : source;
      if (bodies.has(data.id)) {
        const match = frontmatter.exec(source);
        if (!match || match.index !== 0) throw new VaultError('Notes 管理字段损坏', 409);
        source = match[0] + bodies.get(data.id);
      }
      if (!existing || (await this.contentHash(source)) !== existing.revision)
        changes.push({ path: relative, content: source, expected: existing?.revision ?? null });
    }
    return changes;
  }
  async save(
    input: unknown,
    revision?: string,
    options: SaveOptions = {},
    companions: FileChange[] = [],
  ): Promise<Entry> {
    const data = parseRecord(input);
    return this.saveResolved(() => data, revision, options, companions);
  }
  update(
    id: string,
    revision: string,
    transform: (data: RecordData) => RecordData,
    options: SaveOptions = {},
    companions: FileChange[] = [],
  ): Promise<Entry> {
    return this.saveResolved(
      (snapshot) => {
        const matches = snapshot.entries.filter((entry) => entry.data.id === id);
        if (matches.length !== 1 || matches[0].revision !== revision)
          throw new VaultError('对象已更改或不存在，请重新加载', 409);
        return transform(matches[0].data);
      },
      revision,
      options,
      companions,
    );
  }
  private saveResolved(
    resolve: (snapshot: Snapshot) => RecordData,
    revision: string | undefined,
    options: SaveOptions,
    companions: FileChange[],
  ): Promise<Entry> {
    return this.serialized(async () => {
      const settings = saveOptionsSchema.parse(options);
      const snapshot = await this.currentSnapshot();
      let data = parseRecord(resolve(snapshot));
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
        data = { ...data, completedAt: settings.completion ? now : null };
      }
      if (data.type === 'resource' && data.location === 'vault' && data.noteId !== data.id) {
        const targetPath = data.target;
        const fingerprint = await this.resourceFingerprint(targetPath);
        const note = snapshot.entries.find((e) => e.path === targetPath.replaceAll('\\', '/'));
        data = {
          ...data,
          fingerprint,
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
        const itemIds = data.itemIds;
        const linkedIds = [...itemIds, ...data.milestoneIds];
        if (
          settings.newItems.some((r) => !itemIds.includes(r.id)) ||
          settings.completeIds.some((id) => !linkedIds.includes(id))
        )
          throw new VaultError('新条目和本次完成必须关联到这段实际工作');
        for (const id of new Set(settings.completeIds)) {
          const item = changed.get(id) ?? snapshot.entries.find((e) => e.data.id === id)?.data;
          if (item?.type !== 'milestone' && item?.type !== 'todo')
            throw new VaultError('完成对象不存在');
          const records = [
            ...snapshot.entries.map((entry) => changed.get(entry.data.id) ?? entry.data),
            ...settings.newItems,
          ];
          for (const record of this.completionChanges(item, records, now, now))
            changed.set(record.id, record);
        }
      } else if (settings.completeIds.length) throw new VaultError('本次完成只用于实际工作');
      if (
        isSpaceItem(data) &&
        (settings.completion !== undefined ||
          (existing &&
            isSpaceItem(existing.data) &&
            data.completedAt !== existing.data.completedAt))
      ) {
        for (const record of this.completionChanges(
          data,
          snapshot.entries.map((entry) => entry.data),
          data.completedAt,
          now,
        ))
          changed.set(record.id, record);
        data = changed.get(data.id)!;
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
      if (
        (data.type === 'milestone' &&
          existing?.data.type === 'milestone' &&
          (data.title !== existing.data.title ||
            data.dueDate !== existing.data.dueDate ||
            data.dueTime !== existing.data.dueTime)) ||
        (data.type === 'todo' &&
          existing?.data.type === 'todo' &&
          (data.title !== existing.data.title || data.kind !== existing.data.kind))
      ) {
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
      await this.commitChanges([...changes, ...companions]);
      const published = changes.find(
        (change) => change.content !== null && decodeNote(change.content)?.data.id === data.id,
      );
      if (!published && existing) return existing;
      if (!published) throw new VaultError('记录已发布但无法读取，请检查诊断', 409);
      const source = await this.readSource(published.path);
      const publishedRevision = await this.contentHash(source);
      if (publishedRevision !== (await this.contentHash(published.content!)))
        this.invalidateIndex();
      const note = decodeNote(source);
      if (note?.data.id !== data.id) throw new VaultError('记录已发布但无法读取，请检查诊断', 409);
      return { data: note.data, path: published.path, revision: publishedRevision };
    });
  }

  // Trusted application services may publish related metadata with a business operation.
  async applyBatch<T>(
    build: (context: {
      snapshot: Snapshot;
      createLineParts: (line: BusinessLine) => RecordData[];
      notesBody: (line: BusinessLine, bodies: Map<string, string>) => Promise<string>;
      readBody: (entry: Entry) => Promise<string>;
    }) => Promise<{
      records: RecordData[];
      bodies?: Map<string, string>;
      files?: FileChange[];
      result: T;
    }>,
    refresh = false,
  ): Promise<T> {
    return this.serialized(async () => {
      const snapshot = await (refresh ? this.scan() : this.currentSnapshot());
      if (snapshot.issues.length) throw new VaultError('工作目录存在诊断，请先处理后再写入', 409);
      const batch = await build({
        snapshot,
        createLineParts: (line) => this.createLineParts(line),
        notesBody: (line, bodies) => this.notesBody(line, snapshot.entries, bodies),
        readBody: (entry) => this.recordBody(entry),
      });
      const changed = new Map(batch.records.map((record) => [record.id, record]));
      if (changed.size !== batch.records.length) throw new VaultError('批次包含重复 ID', 409);
      const virtual = [
        ...snapshot.entries.filter((entry) => !changed.has(entry.data.id)),
        ...batch.records.map((data) => ({ data, path: '', revision: '' })),
      ];
      for (const record of batch.records) validateChange(parseRecord(record), virtual);
      await this.commitChanges([
        ...(await this.prepareChanges(snapshot.entries, batch.records, batch.bodies)),
        ...(batch.files ?? []),
      ]);
      return batch.result;
    });
  }

  async createMarkdown(input: unknown): Promise<Entry> {
    const fields = noteInputSchema.parse(input);
    return this.serialized(async () => {
      await this.currentSnapshot();
      const id = crypto.randomUUID(),
        now = new Date().toISOString();
      const relative = recordPath(id);
      const data = createRecord(
        'resource',
        {
          id,
          ...fields,
          target: relative,
          location: 'vault',
          noteId: id,
        },
        now,
      );
      const source = newNote(data);
      await this.commitChanges([{ path: relative, content: source, expected: null }]);
      return { data, path: relative, revision: await this.contentHash(source) };
    });
  }
  private async contentSource(id: string) {
    const snapshot = await this.currentSnapshot();
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
    const source = await this.readSource(note.path);
    const decoded = decodeNote(source);
    if (!decoded || JSON.stringify(decoded.data) !== JSON.stringify(note.data))
      throw new VaultError('Notes 结构已被外部修改，请重新加载', 409);
    const revision = await this.contentHash(source);
    if (revision !== note.revision)
      this.rememberSnapshot({
        ...snapshot,
        entries: snapshot.entries.map((entry) =>
          entry.path === note.path ? { ...note, revision } : entry,
        ),
      });
    const header = frontmatter.exec(source);
    if (!header || header.index !== 0) throw new VaultError('Notes 管理字段损坏');
    return { source, note, item, header: header[0], body: source.slice(header[0].length) };
  }
  async readContent(id: string): Promise<NoteContent> {
    return this.serialized(async () => {
      const { source, note, item, body } = await this.contentSource(id);
      const revision = await this.contentHash(source);
      if (item.type === 'milestone' || item.type === 'todo') {
        const content = editableSection(body, item);
        return { body: content.body, comments: content.comments, revision, path: note.path };
      }
      const snapshot = await this.currentSnapshot();
      let intro = body;
      const sections: NonNullable<NoteContent['sections']> = [];
      for (const { data } of snapshot.entries) {
        if (
          (data.type !== 'milestone' && data.type !== 'todo') ||
          lineFor(data, snapshot.entries)?.id !== item.id
        )
          continue;
        const found = section(body, data.type === 'todo' ? 'item' : 'node', data.id);
        if (!found) continue;
        const content = editableSection(body, data);
        sections.push({
          id: data.id,
          title: data.title,
          heading:
            data.type === 'milestone'
              ? `${data.dueDate ?? '未定日期'}${data.dueTime ? ' ' + data.dueTime : ''} · ${data.title}`
              : `${data.kind === 'idea' ? 'IDEA' : 'TODO'} · ${data.title}`,
          kind: data.type,
          body: content.body,
          comments: content.comments,
          revision,
          path: note.path,
        });
        if (data.type === 'milestone') intro = putSection(intro, 'node', data.id, null);
      }
      sections.sort(
        (a, b) =>
          section(body, a.kind === 'todo' ? 'item' : 'node', a.id)!.from -
          section(body, b.kind === 'todo' ? 'item' : 'node', b.id)!.from,
      );
      return {
        body: displayNotes(body),
        intro: displayNotes(intro),
        sections,
        revision,
        path: note.path,
      };
    });
  }
  async saveContent(
    id: string,
    body: string,
    revision: string,
    comments?: { id: string; text: string }[],
  ): Promise<NoteContent> {
    return this.serialized(async () => {
      const current = await this.contentSource(id);
      if (current.item.type !== 'milestone' && current.item.type !== 'todo')
        throw new VaultError('业务线 Notes 为只读汇总，请编辑具体节点或条目的内部内容');
      if ((await this.contentHash(current.source)) !== revision)
        throw new VaultError('文件已被外部修改，未覆盖正文；请保留草稿并重新加载', 409);
      const snapshot = await this.currentSnapshot();
      const item = current.item;
      const node =
        item.type === 'milestone'
          ? item
          : snapshot.entries.find((entry) => entry.data.id === item.milestoneId)?.data;
      if (node?.type !== 'milestone') throw new VaultError('所属节点不存在');
      const updated = replaceContent(
        current.body,
        node,
        current.item.type === 'todo' ? current.item : undefined,
        body,
        comments,
      );
      await this.commitChanges([
        { path: current.note.path, expected: revision, content: current.header + updated },
      ]);
      const content = editableSection(updated, current.item);
      return {
        body: content.body,
        comments: content.comments,
        revision: await this.contentHash(current.header + updated),
        path: current.note.path,
      };
    });
  }
  async appendContent(id: string, text: string, revision: string) {
    return this.serialized(async () => {
      const current = await this.contentSource(id);
      if (current.item.type !== 'workline') throw new VaultError('随手记须属于业务线');
      if (/<!--\s*\/?atlas:/i.test(text)) throw new VaultError('不能提交系统结构标记');
      if ((await this.contentHash(current.source)) !== revision)
        throw new VaultError('Notes 已更改，请刷新后重试', 409);
      await this.commitChanges([
        {
          path: current.note.path,
          expected: revision,
          content: current.source.trimEnd() + `\n\n## 随手记 · ${localDay()}\n\n${text.trim()}\n`,
        },
      ]);
      return {};
    });
  }
  async promote(id: string, revision: string): Promise<Entry> {
    return this.serialized(async () => {
      const snapshot = await this.currentSnapshot(),
        matches = snapshot.entries.filter((e) => e.data.id === id);
      if (matches.length > 1) throw new VaultError('重复 ID，拒绝升线', 409);
      const entry = matches[0];
      if (!entry) throw new VaultError('升线对象不存在', 409);
      if (entry.data.type === 'workline') return entry;
      if (entry.revision !== revision) throw new VaultError('对象已更改，请重新加载后升线', 409);
      const item = entry.data;
      if (!canPromote(item))
        throw new VaultError(
          item.type === 'milestone' && item.pool
            ? '待办池不能升级'
            : '只有节点、TODO、IDEA可升为业务线',
        );
      const oldLine = lineFor(item, snapshot.entries)!;
      const line = createRecord(
        'workline',
        {
          id: item.id,
          createdAt: item.createdAt,
          title: item.title,
          importance: item.importance,
          projectId: oldLine.projectId,
          resourceIds: item.resourceIds,
        },
        new Date().toISOString(),
      ) as BusinessLine;
      const parts = this.createLineParts(line);
      const newLine = parts[0] as BusinessLine,
        pool = parts.find((r) => r.type === 'milestone') as Milestone;
      // A scheduled commitment remains a real node, rather than losing its deadline on promotion.
      const destination =
        item.type === 'milestone' && (item.dueDate || item.tags.length)
          ? { ...item, id: crypto.randomUUID(), lineId: newLine.id, resourceIds: [] }
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
      return (await this.currentSnapshot()).entries.find((e) => e.data.id === id)!;
    });
  }

  async deletePreview(id: string): Promise<DeletePreview> {
    const snapshot = await this.currentSnapshot();
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
      const snapshot = await this.currentSnapshot(),
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

  async deleteActual(id: string, revision: string): Promise<DeleteResult> {
    return this.serialized(async () => {
      const snapshot = await this.currentSnapshot();
      const entries = snapshot.entries.filter((entry) => entry.data.id === id);
      const entry = entries[0];
      if (entries.length !== 1 || entry.data.type !== 'actual' || entry.revision !== revision)
        throw new VaultError('实际记录已更改或不存在，请重新加载后再删除', 409);
      await this.commitChanges([{ path: entry.path, expected: revision, content: null }]);
      return { deletedIds: [id] };
    });
  }
  async initialize() {
    return this.serialized(async () => {
      const snapshot = await this.scan();
      if (!snapshot.files.some((file) => file.path === layoutPath)) {
        if (snapshot.issues.length)
          throw new VaultError('工作目录存在诊断，未转换文件路径，请先检查目录', 409);
        await this.organizeSnapshot(snapshot);
      }
      const next = await this.currentSnapshot();
      this.takePublishedSnapshot();
      return next;
    });
  }
  private async organizeSnapshot(snapshot: Snapshot) {
    const moves = new Map(
      snapshot.entries
        .filter((entry) => entry.path !== recordPath(entry.data.id))
        .map((entry) => [entry.path, recordPath(entry.data.id)]),
    );
    const changes: FileChange[] = [];
    const records = new Set(snapshot.entries.map((entry) => entry.path));
    for (const file of snapshot.files) {
      if (file.directory || !/\.md$/i.test(file.path)) continue;
      const source = await this.readSource(file.path);
      const header = frontmatter.exec(source);
      checkRelocationLinks(
        source.slice(header?.index === 0 ? header[0].length : 0),
        file.path,
        moves,
      );
      if (!records.has(file.path)) continue;
      const entry = snapshot.entries.find((entry) => entry.path === file.path)!;
      if ((await this.contentHash(source)) !== entry.revision)
        throw new VaultError('文件已更改，停止整理', 409);
      const destination = recordPath(entry.data.id);
      const data = entry.data;
      const updated =
        data.type === 'resource' &&
        data.location === 'vault' &&
        (data.noteId === data.id || moves.has(data.target))
          ? updateNote(source, {
              ...data,
              target: data.noteId === data.id ? destination : moves.get(data.target)!,
            })
          : source;
      if (destination !== entry.path) {
        changes.push(
          { path: destination, content: updated, expected: null },
          { path: entry.path, content: null, expected: entry.revision },
        );
      } else if (updated !== source)
        changes.push({ path: entry.path, content: updated, expected: entry.revision });
    }
    if (!snapshot.files.some((file) => file.path === layoutPath))
      changes.push({ path: layoutPath, content: layoutSource, expected: null });
    await this.commitChanges(changes);
    return { moved: moves.size };
  }
}
