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
} from './line-notes';

import { VaultError } from './errors';
import type { FileChange } from './file-change';
import { decodeNote, frontmatter, newNote, updateNote } from './markdown';

// Platform adapters implement file safety and publication; business rules stay here.
export abstract class Workspace {
  async progress(_phase: string, _completed: number, _total: number): Promise<void> {}
  abstract scan(): Promise<Snapshot>;
  snapshot(): Promise<Snapshot> {
    return this.serialized(() => this.scan());
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
  protected abstract commitChanges(changes: FileChange[]): Promise<void>;
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
    const relative = `ATLAS/knowledge/业务线/${notesId}.md`;
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
        (data.type === 'resource' && data.noteId === data.id
          ? data.target
          : `ATLAS/${data.type}/${data.id}.md`);
      let source = existing ? await this.readSource(relative) : newNote(data);
      if (existing && (await this.contentHash(source)) !== existing.revision)
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
      await this.commitChanges([...changes, ...companions]);
      const published = changes.find(
        (change) => change.content !== null && decodeNote(change.content)?.data.id === data.id,
      );
      if (!published && existing) return existing;
      if (!published) throw new VaultError('记录已发布但无法读取，请检查诊断', 409);
      const source = await this.readSource(published.path);
      const note = decodeNote(source);
      if (note?.data.id !== data.id) throw new VaultError('记录已发布但无法读取，请检查诊断', 409);
      return { data: note.data, path: published.path, revision: await this.contentHash(source) };
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
  ): Promise<T> {
    return this.serialized(async () => {
      const snapshot = await this.scan();
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
      const id = crypto.randomUUID(),
        now = new Date().toISOString();
      const name =
        fields.title
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
          .replace(/[. ]+$/g, '')
          .slice(0, 60) || '笔记';
      const relative = `ATLAS/knowledge/${fields.tag || '未分类'}/${name}-${id}.md`;
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
      await this.atomic(relative, source, null);
      return { data, path: relative, revision: await this.contentHash(source) };
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
    const source = await this.readSource(note.path);
    if ((await this.contentHash(source)) !== note.revision)
      throw new VaultError('Notes 已被外部修改，请重新加载', 409);
    const header = frontmatter.exec(source);
    if (!header || header.index !== 0) throw new VaultError('Notes 管理字段损坏');
    return { source, note, item, header: header[0], body: source.slice(header[0].length) };
  }
  async readContent(id: string): Promise<NoteContent> {
    return this.serialized(async () => {
      const { source, note, item, body } = await this.contentSource(id);
      const text =
        item.type === 'workline'
          ? body
          : (section(body, item.type === 'todo' ? 'item' : 'node', item.id)?.text ?? '');
      return { body: text, revision: await this.contentHash(source), path: note.path };
    });
  }
  async saveContent(id: string, body: string, revision: string): Promise<NoteContent> {
    return this.serialized(async () => {
      const current = await this.contentSource(id);
      if (current.item.type !== 'workline')
        throw new VaultError('请在业务线 Notes 中编辑全文，条目使用添加批注');
      if ((await this.contentHash(current.source)) !== revision)
        throw new VaultError('文件已被外部修改，未覆盖正文；请保留草稿并重新加载', 409);
      await this.commitChanges([
        { path: current.note.path, expected: revision, content: current.header + body },
      ]);
      return {
        body,
        revision: await this.contentHash(current.header + body),
        path: current.note.path,
      };
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
      return (await this.scan()).entries.find((e) => e.data.id === id)!;
    });
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

  async deleteActual(id: string, revision: string): Promise<DeleteResult> {
    return this.serialized(async () => {
      const snapshot = await this.scan();
      const entries = snapshot.entries.filter((entry) => entry.data.id === id);
      const entry = entries[0];
      if (entries.length !== 1 || entry.data.type !== 'actual' || entry.revision !== revision)
        throw new VaultError('实际记录已更改或不存在，请重新加载后再删除', 409);
      await this.commitChanges([{ path: entry.path, expected: revision, content: null }]);
      return { deletedIds: [id] };
    });
  }
}
