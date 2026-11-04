import { expect, it } from 'vitest';
import { createAndroidTransport } from '../apps/android/runtime/index';
import { AndroidWorkspace, type NativeCall } from '../apps/android/runtime/workspace';
import { WorkspaceService } from '../packages/workspace/workspace-service';
import { createRecord, localDay, type Snapshot } from '../packages/domain/index';
import { isComplete } from '../packages/domain/workspace';
import type { FileChange } from '../packages/workspace/file-change';
import type { ExchangeBundle, ExchangePreview, ExchangeReceipt } from '../packages/domain/exchange';

async function fixture() {
  const files = new Map<string, string>();
  const hash = async (text: string) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
      (v) => v.toString(16).padStart(2, '0'),
    ).join('');
  const native: NativeCall = async <T>(method: string, input?: unknown): Promise<T> => {
    const args = input as Record<string, any>;
    let value: unknown;
    if (method === 'session' || method === 'chooseDirectory')
      value = { root: 'content://test/tree/local', vaultId: 'session' };
    else if (method === 'remember') value = null;
    else if (method === 'scan')
      value = await Promise.all(
        [...files].map(async ([path, source]) => ({
          path,
          directory: false,
          source,
          revision: await hash(source),
        })),
      );
    else if (method === 'read') {
      if (!files.has(args.path)) throw new Error('missing');
      value = files.get(args.path);
    } else if (method === 'fingerprint')
      value = files.has(args.path) ? await hash(files.get(args.path)!) : null;
    else if (method === 'commit') {
      const changes = args.changes as FileChange[];
      for (const change of changes)
        if (
          (files.has(change.path) ? await hash(files.get(change.path)!) : null) !== change.expected
        )
          throw new Error('revision conflict');
      for (const change of changes) {
        if (change.content === null) files.delete(change.path);
        else files.set(change.path, change.content);
      }
    } else throw new Error('unexpected native method ' + method);
    return value as T;
  };
  const workspace = new AndroidWorkspace(
    { root: 'content://test/tree/local', vaultId: 'session' },
    native,
  );
  const service = new WorkspaceService(workspace);
  const project = await service.saveRecord(createRecord('project', { title: '手机项目' }));
  const line = await service.saveRecord(
    createRecord('workline', { title: '手机业务线', projectId: project.data.id }),
  );
  return { files, native, workspace, service, project, line };
}

it('Android 保存只完整扫描一次，读取仍按真实内容指纹识别外部修改', async () => {
  const { native, files, project } = await fixture();
  let scans = 0;
  const measured: NativeCall = (method, input) => {
    if (method === 'scan') scans++;
    return native(method, input);
  };
  const workspace = new AndroidWorkspace(
    { root: 'content://test/tree/local', vaultId: 'session' },
    measured,
  );
  const service = new WorkspaceService(workspace);
  await service.saveRecord({ ...project.data, title: '一次扫描完成保存' }, project.revision);
  expect(scans).toBe(1);
  expect(
    workspace.takePublishedSnapshot()?.entries.find((entry) => entry.data.id === project.data.id)
      ?.data,
  ).toMatchObject({ title: '一次扫描完成保存' });
  expect(workspace.takePublishedSnapshot()).toBeUndefined();
  const first = await service.snapshot();
  expect(await service.snapshot()).toBe(first);
  files.set(project.path, files.get(project.path)!.replace('一次扫描完成保存', '外部编辑'));
  expect(
    (await service.snapshot()).entries.find((entry) => entry.data.id === project.data.id)?.data,
  ).toMatchObject({ title: '外部编辑' });
});

it('Android 同次扫描复用原文，Notes 和交换不逐文件再跨桥读取，下一次请求仍识别外部修改', async () => {
  const { native, files, line } = await fixture();
  const calls: string[] = [];
  const measured: NativeCall = (method, input) => {
    calls.push(method);
    return native(method, input);
  };
  const workspace = new AndroidWorkspace(
    { root: 'content://test/tree/local', vaultId: 'session' },
    measured,
  );
  const service = new WorkspaceService(workspace);
  const note = (await service.execute({ type: 'notes.read', id: line.data.id })) as {
    body: string;
    path: string;
  };
  expect(note.body).toContain('手机业务线');
  expect(calls).toEqual(['scan']);
  files.set(note.path, files.get(note.path)! + '\n外部新增正文\n');
  calls.length = 0;
  expect(await service.execute({ type: 'notes.read', id: line.data.id })).toMatchObject({
    body: expect.stringContaining('外部新增正文'),
  });
  expect(calls).toEqual(['scan']);
  calls.length = 0;
  await service.execute({ type: 'exchange.export' });
  expect(calls).toEqual(['scan']);
});

it('复用扫描原文仍由原生发布拒绝扫描后发生的外部修改', async () => {
  const { native, files, project } = await fixture();
  const changedAfterScan: NativeCall = async <T>(method: string, input?: unknown): Promise<T> => {
    const result = await native<T>(method, input);
    if (method === 'scan') files.set(project.path, files.get(project.path)! + '\n外部原文\n');
    return result;
  };
  const service = new WorkspaceService(
    new AndroidWorkspace(
      { root: 'content://test/tree/local', vaultId: 'session' },
      changedAfterScan,
    ),
  );
  await expect(
    service.saveRecord({ ...project.data, title: '不应覆盖' }, project.revision),
  ).rejects.toThrow('revision conflict');
  expect(files.get(project.path)).toContain('外部原文');
  expect(files.get(project.path)).not.toContain('不应覆盖');
});

it('删除实际记录保留完成事实和 Notes，并拒绝陈旧版本及其他对象类型', async () => {
  const { service, files, line, project } = await fixture();
  const node = await service.saveRecord(
    createRecord('milestone', { title: '已有节点', lineId: line.data.id }),
  );
  const todo = await service.saveRecord(
    createRecord('todo', { title: '已有行动', milestoneId: node.data.id }),
  );
  const actual = await service.saveRecord(
    createRecord('actual', {
      date: localDay(),
      startTime: '08:00',
      endTime: '09:00',
      description: '真实记录',
      itemIds: [todo.data.id],
    }),
    undefined,
    {
      completeIds: [todo.data.id],
      comments: [{ id: crypto.randomUUID(), targetId: todo.data.id, text: '保留纪要正文' }],
    },
  );
  await expect(
    service.execute({ type: 'actual.delete', id: actual.data.id, revision: project.revision }),
  ).rejects.toThrow();
  await expect(
    service.execute({ type: 'actual.delete', id: project.data.id, revision: project.revision }),
  ).rejects.toThrow();
  const preserved = new Map(files);
  await service.execute({ type: 'actual.delete', id: actual.data.id, revision: actual.revision });
  preserved.delete(actual.path);
  expect(files).toEqual(preserved);
  const snapshot = await service.snapshot();
  expect(snapshot.entries.some((entry) => entry.data.id === actual.data.id)).toBe(false);
  expect(
    isComplete(
      snapshot.entries.find((entry) => entry.data.id === todo.data.id)!.data as any,
      snapshot.entries,
    ),
  ).toBe(true);
});

it('写入后读回发现外部更改时丢弃待交付快照', async () => {
  const { native, files, project } = await fixture();
  const changedAfterCommit: NativeCall = async <T>(method: string, input?: unknown): Promise<T> => {
    const result = await native<T>(method, input);
    if (method === 'commit')
      files.set(project.path, files.get(project.path)!.replace('本次修改', '发布后外部修改'));
    return result;
  };
  const workspace = new AndroidWorkspace(
    { root: 'content://test/tree/local', vaultId: 'session' },
    changedAfterCommit,
  );
  const service = new WorkspaceService(workspace);
  const result = await service.saveRecord({ ...project.data, title: '本次修改' }, project.revision);
  expect(result.data).toMatchObject({ title: '发布后外部修改' });
  expect(workspace.takePublishedSnapshot()).toBeUndefined();
});

it('Android adapter uses the shared complete, actual, Notes, reschedule and promote operations', async () => {
  const { service, line } = await fixture();
  const node = await service.saveRecord(
    createRecord('milestone', { title: '手机节点', lineId: line.data.id, dueDate: localDay() }),
  );
  const todo = await service.saveRecord(
    createRecord('todo', { title: '手机待办', milestoneId: node.data.id }),
  );
  await service.saveRecord(
    createRecord('actual', {
      date: localDay(),
      startTime: '09:00',
      endTime: '10:00',
      description: '离线工作',
      itemIds: [todo.data.id],
    }),
    undefined,
    {
      completeIds: [todo.data.id],
      comments: [{ id: crypto.randomUUID(), targetId: todo.data.id, text: '同一份正文' }],
    },
  );
  let snapshot = await service.snapshot();
  expect(
    isComplete(
      snapshot.entries.find((entry) => entry.data.id === node.data.id)!.data as any,
      snapshot.entries,
    ),
  ).toBe(true);
  const body = (await service.execute({ type: 'notes.read', id: line.data.id })) as {
    body: string;
  };
  expect(body.body.match(/同一份正文/g)).toHaveLength(1);
  const current = snapshot.entries.find((entry) => entry.data.id === todo.data.id)!;
  await service.complete(current.data.id, current.revision, false);
  snapshot = await service.snapshot();
  const active = snapshot.entries.find((entry) => entry.data.id === todo.data.id)!;
  await service.reschedule(active.data.id, active.revision, '2099-01-01');
  snapshot = await service.snapshot();
  const moved = snapshot.entries.find((entry) => entry.data.id === todo.data.id)!;
  if (moved.data.type !== 'todo') throw new Error('expected todo');
  const poolId = moved.data.milestoneId;
  expect(
    snapshot.entries.some(
      (entry) => entry.data.type === 'milestone' && entry.data.pool && entry.data.id === poolId,
    ),
  ).toBe(true);
  await service.execute({ type: 'work.promote', id: moved.data.id, revision: moved.revision });
  const promoted = (await service.snapshot()).entries.find(
    (entry) => entry.data.id === todo.data.id,
  )!;
  expect(promoted.data.type).toBe('workline');
});

it('Android preserves free Markdown, YAML, BOM, newline and rejects stale updates', async () => {
  const { files, service, project } = await fixture();
  const source =
    '\ufeff' +
    files
      .get(project.path)!
      .replace('---\n', '---\nexternal: keep # user\n')
      .replaceAll('\n', '\r\n') +
    '\r\n自由正文，不能覆盖\r\n';
  files.set(project.path, source);
  await expect(
    service.saveRecord({ ...project.data, title: 'stale' }, project.revision),
  ).rejects.toThrow();
  const current = (await service.snapshot()).entries.find(
    (entry) => entry.data.id === project.data.id,
  )!;
  await service.saveRecord({ ...current.data, title: '新名称' }, current.revision);
  expect(files.get(project.path)).toContain('external: keep # user\r\n');
  expect(files.get(project.path)).toContain('自由正文，不能覆盖\r\n');
  expect(files.get(project.path)!.charCodeAt(0)).toBe(0xfeff);
});

it('Android reports duplicate IDs and cannot write either duplicate', async () => {
  const { files, service, project } = await fixture();
  files.set('duplicate.md', files.get(project.path)!);
  expect((await service.snapshot()).issues.some((issue) => issue.message.includes('重复 ID'))).toBe(
    true,
  );
  await expect(
    service.saveRecord({ ...project.data, title: '不应发布' }, project.revision),
  ).rejects.toThrow();
});

it('Android transport runs offline commands and rejects excluded integrations', async () => {
  const { native } = await fixture();
  const transport = createAndroidTransport(native);
  expect(await transport('session')).toMatchObject({ connected: true });
  const response = (await transport('business/v1/workspace')) as {
    version: string;
    snapshot: Snapshot;
  };
  expect(response.version).toBe('1');
  expect(response.snapshot.entries.some((entry) => entry.data.type === 'workline')).toBe(true);
  await expect(transport('messages')).rejects.toThrow('不支持');
  await transport('connect');
});

it('Android 使用同一交换命令，导入 Notes 与结构并可返回增量回执', async () => {
  const sender = await fixture(),
    receiver = await fixture();
  const bundle = (await sender.service.execute({ type: 'exchange.export' })) as ExchangeBundle;
  const preview = (await receiver.service.execute({
    type: 'exchange.preview',
    bundle,
  })) as ExchangePreview;
  expect(preview.errors).toEqual([]);
  const result = (await receiver.service.execute({
    type: 'exchange.apply',
    bundle,
    revision: preview.revision,
  })) as { receipt: ExchangeReceipt };
  const delta = (await sender.service.execute({
    type: 'exchange.export',
    baseline: result.receipt,
  })) as ExchangeBundle;
  expect(delta.changes).toHaveLength(0);
  expect((await receiver.service.snapshot()).issues).toEqual([]);
});
