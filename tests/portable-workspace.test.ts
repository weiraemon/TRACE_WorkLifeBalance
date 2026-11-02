import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { parseRecord, validateChange, type Snapshot, type Entry } from '../packages/domain/index';
import { isComplete } from '../packages/domain/workspace';
import { Workspace } from '../packages/workspace/workspace';
import { workspaceServiceFor } from '../packages/workspace/workspace-service';
import { VaultError } from '../packages/workspace/errors';
import { decodeNote } from '../packages/workspace/markdown';
import type { FileChange } from '../packages/workspace/file-change';

// A second adapter exercises the actual shared rules with asynchronous Web Crypto,
// without relying on Node paths, files, locks or synchronous hashing.
function memoryWorkspace(Base = Workspace) {
  return new (class extends Base {
    readonly files = new Map<string, string>();
    private tail: Promise<unknown> = Promise.resolve();
    async scan(): Promise<Snapshot> {
      const entries: Entry[] = [];
      for (const [path, source] of this.files) {
        if (!path.endsWith('.md')) continue;
        const note = decodeNote(source);
        if (note) entries.push({ data: note.data, path, revision: await this.contentHash(source) });
      }
      for (const { data } of entries) validateChange(data, entries);
      return {
        root: 'memory',
        vaultId: 'test-session',
        entries,
        issues: [],
        files: [...this.files.keys()].map((path) => ({ path, directory: false })),
      };
    }
    protected async readSource(path: string) {
      const source = this.files.get(path);
      if (source === undefined) throw new VaultError('文件不存在');
      return source;
    }
    protected async contentHash(source: string) {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
      return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    protected async resourceFingerprint(path: string) {
      return this.contentHash(await this.readSource(path));
    }
    protected serialized<T>(fn: () => Promise<T>): Promise<T> {
      const task = this.tail.then(fn);
      this.tail = task.catch(() => {});
      return task;
    }
    protected async atomic(path: string, content: string, expected: string | null) {
      await this.commitChanges([{ path, content, expected }]);
    }
    protected async commitChanges(changes: FileChange[]) {
      if (new Set(changes.map((change) => change.path)).size !== changes.length)
        throw new VaultError('同一文件不能重复发布');
      for (const change of changes) {
        const source = this.files.get(change.path);
        const current = source === undefined ? null : await this.contentHash(source);
        if (current !== change.expected) throw new VaultError('文件已更改', 409);
      }
      for (const change of changes) {
        if (change.content === null) this.files.delete(change.path);
        else this.files.set(change.path, change.content);
      }
    }
  })();
}

const make = (type: string, fields: object) =>
  parseRecord({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    type,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...fields,
  });

async function setup(vault = memoryWorkspace(), serviceFor = workspaceServiceFor) {
  const service = serviceFor(vault);
  const project = await service.saveRecord(make('project', { title: '共享核心' }));
  const line = await service.saveRecord(
    make('workline', { title: '验证', projectId: project.data.id }),
  );
  await service.createPlan({
    kind: 'event',
    title: '讨论',
    lineId: line.data.id,
    dueDate: '2026-11-02',
    actions: ['检查结果'],
    note: { id: crypto.randomUUID(), text: '会议原文', date: '2026-11-02' },
  });
  const snapshot = await service.snapshot();
  const node = snapshot.entries.find((e) => e.data.type === 'milestone' && !e.data.pool)!;
  const todo = snapshot.entries.find((e) => e.data.type === 'todo')!;
  return { vault, service, project, line, node, todo };
}

it('共享业务可以打包为浏览器代码，并在没有 Node 或 DOM 的上下文完成计划和实际录入', async () => {
  const bundle = await build({
    stdin: {
      contents: `export { Workspace } from './packages/workspace/workspace';
        export { workspaceServiceFor } from './packages/workspace/workspace-service';`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    platform: 'browser',
    format: 'iife',
    globalName: 'ChaosCore',
    bundle: true,
    write: false,
  });
  const portable = runInNewContext(bundle.outputFiles[0].text + '; ChaosCore;', {
    crypto,
    TextEncoder,
    TextDecoder,
  }) as { Workspace: typeof Workspace; workspaceServiceFor: typeof workspaceServiceFor };
  const { service, line, node, todo } = await setup(
    memoryWorkspace(portable.Workspace),
    portable.workspaceServiceFor,
  );
  await service.saveRecord(
    make('actual', {
      date: '2026-11-02',
      startTime: '10:00',
      endTime: '11:00',
      description: '真实投入',
      itemIds: [todo.data.id],
      milestoneIds: [node.data.id],
    }),
    undefined,
    {
      completeIds: [todo.data.id],
      comments: [
        { id: crypto.randomUUID(), targetId: todo.data.id, text: '验证通过', date: '2026-11-02' },
      ],
    },
  );
  const snapshot = await service.snapshot();
  expect(snapshot.entries.filter((e) => e.data.type === 'actual')).toHaveLength(1);
  expect(
    isComplete(snapshot.entries.find((e) => e.data.id === node.data.id)!.data, snapshot.entries),
  ).toBe(true);
  expect(snapshot.entries.find((e) => e.data.id === line.data.id)!.data).toHaveProperty(
    'completedAt',
    null,
  );
  expect(await service.execute({ type: 'notes.read', id: line.data.id })).toHaveProperty(
    'body',
    expect.stringContaining('验证通过'),
  );
});

it('异步存储下改期迁移 Notes，升线和删除仍保留批注与真实投入', async () => {
  const { vault, service, line, todo } = await setup();
  await service.execute({
    type: 'work.comment',
    id: todo.data.id,
    revision: todo.revision,
    text: '不能丢失的批注',
  });
  const commented = (await service.snapshot()).entries.find((e) => e.data.id === todo.data.id)!;
  await service.execute({
    type: 'work.reschedule',
    id: todo.data.id,
    revision: commented.revision,
    dueDate: '2026-11-03',
  });
  let snapshot = await service.snapshot();
  const moved = snapshot.entries.find((e) => e.data.id === todo.data.id)!;
  expect(moved.data).toHaveProperty(
    'milestoneId',
    snapshot.entries.find((e) => e.data.type === 'milestone' && e.data.pool)!.data.id,
  );
  await service.saveRecord(
    make('actual', {
      date: '2026-11-02',
      startTime: '10:00',
      endTime: '11:00',
      description: '推进事项',
      itemIds: [todo.data.id],
    }),
  );
  await service.execute({ type: 'work.promote', id: todo.data.id, revision: moved.revision });
  expect((await vault.readContent(todo.data.id)).body).toContain('不能丢失的批注');
  expect((await vault.readContent(line.data.id)).body).not.toContain('不能丢失的批注');
  const preview = await vault.deletePreview(todo.data.id);
  await vault.deleteSpace(
    todo.data.id,
    Object.fromEntries(preview.entries.map((e) => [e.data.id, e.revision])),
  );
  snapshot = await service.snapshot();
  expect(snapshot.entries.filter((e) => e.data.type === 'actual')).toHaveLength(1);
  expect([...vault.files.values()].join('\n')).toContain('不能丢失的批注');
});

it('异步适配器拒绝过期版本和伴随文件冲突，不覆盖外部正文或部分发布计划', async () => {
  const { vault, service, todo, line } = await setup();
  vault.files.set(todo.path, vault.files.get(todo.path)! + '\n外部正文\n');
  await expect(service.complete(todo.data.id, todo.revision, true)).rejects.toMatchObject({
    status: 409,
  });
  expect(vault.files.get(todo.path)).toContain('外部正文');
  const before = [...vault.files.entries()];
  await expect(
    service.createPlan({ kind: 'task', title: '不能部分发布', lineId: line.data.id }, [
      { path: 'metadata.json', expected: '过期版本', content: '{}' },
    ]),
  ).rejects.toMatchObject({ status: 409 });
  expect([...vault.files.entries()]).toEqual(before);
});
