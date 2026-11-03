import { expect, it } from 'vitest';
import { createAndroidTransport } from '../apps/android/runtime/index';
import { AndroidWorkspace, type NativeCall } from '../apps/android/runtime/workspace';
import { WorkspaceService } from '../packages/workspace/workspace-service';
import { createRecord, localDay, type Snapshot } from '../packages/domain/index';
import { isComplete } from '../packages/domain/workspace';
import type { FileChange } from '../packages/workspace/file-change';

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
