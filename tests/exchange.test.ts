import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../apps/local-service/src/native/vault';
import { workspaceServiceFor } from '../packages/workspace/workspace-service';
import { createRecord } from '../packages/domain/index';
import {
  exchangeHash,
  exchangeMaxBytes,
  parseExchange,
  sealExchange,
  type ExchangeBundle,
  type ExchangeReceipt,
  type ExchangePreview,
} from '../packages/domain/exchange';

const opened: { root: string; vault: Vault }[] = [];
afterEach(async () => {
  for (const { root, vault } of opened.splice(0)) {
    await vault.close();
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^chaos-exchange-/);
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function empty() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-exchange-'));
  const vault = await Vault.open(root);
  opened.push({ root, vault });
  const service = workspaceServiceFor(vault);
  const send = (baseline?: ExchangeReceipt) =>
    service.execute({ type: 'exchange.export', baseline }) as Promise<ExchangeBundle>;
  const preview = (bundle: ExchangeBundle) =>
    service.execute({ type: 'exchange.preview', bundle }) as Promise<ExchangePreview>;
  const apply = async (bundle: ExchangeBundle, revision?: string) =>
    service.execute({
      type: 'exchange.apply',
      bundle,
      revision: revision ?? (await preview(bundle)).revision,
    }) as Promise<{ receipt: ExchangeReceipt; imported: number; skipped: number }>;
  return { root, service, send, preview, apply };
}
async function pair() {
  const sender = await empty(),
    receiver = await empty();
  const project = await sender.service.saveRecord(createRecord('project', { title: '跨端项目' }));
  const line = await sender.service.saveRecord(
    createRecord('workline', { title: '跨端业务线', projectId: project.data.id }),
  );
  await sender.service.createPlan({
    kind: 'event',
    title: '交流',
    lineId: line.data.id,
    dueDate: '2026-11-03',
    actions: ['整理材料'],
    note: { id: crypto.randomUUID(), text: '初始原文', date: '2026-11-03' },
  });
  const todo = (await sender.service.snapshot()).entries.find(
    (entry) => entry.data.type === 'todo',
  )!;
  const first = await sender.send(),
    result = await receiver.apply(first);
  return { sender, receiver, project, line, todo, first, receipt: result.receipt };
}

it('全量建立共同版本，完成与实际及 Notes 增量联合导入；重放无副作用，回执可反向发送', async () => {
  const { sender, receiver, line, todo, first, receipt } = await pair();
  expect(JSON.stringify(first)).not.toContain(sender.root.replaceAll('\\', '\\\\'));
  expect((await sender.send(receipt)).changes).toHaveLength(0);
  await sender.service.saveRecord(
    createRecord('actual', {
      date: '2026-11-03',
      startTime: '09:00',
      endTime: '10:00',
      description: '真实投入',
      itemIds: [todo.data.id],
    }),
    undefined,
    {
      completeIds: [todo.data.id],
      comments: [{ id: crypto.randomUUID(), targetId: todo.data.id, text: '整理完成' }],
    },
  );
  const delta = await sender.send(receipt);
  expect(delta.changes).toHaveLength(3);
  const result = await receiver.apply(delta);
  expect(result.imported).toBe(3);
  const snapshot = await receiver.service.snapshot();
  expect(snapshot.issues).toEqual([]);
  expect(snapshot.entries.find((entry) => entry.data.id === todo.data.id)!.data).toHaveProperty(
    'completedAt',
    expect.any(String),
  );
  expect(await receiver.service.execute({ type: 'notes.read', id: line.data.id })).toHaveProperty(
    'body',
    expect.stringContaining('整理完成'),
  );
  const revisions = snapshot.entries.map((entry) => entry.revision).sort();
  expect((await receiver.apply(delta)).imported).toBe(0);
  expect((await receiver.service.snapshot()).entries.map((entry) => entry.revision).sort()).toEqual(
    revisions,
  );
  const current = snapshot.entries.find((entry) => entry.data.id === todo.data.id)!;
  await receiver.service.saveRecord(
    { ...current.data, title: '手机调整后的标题' },
    current.revision,
  );
  const reverse = await receiver.send(result.receipt);
  expect(reverse.changes.length).toBeGreaterThan(0);
  await sender.apply(reverse);
  expect(
    (await sender.service.snapshot()).entries.find((entry) => entry.data.id === todo.data.id)!.data,
  ).toHaveProperty('title', '手机调整后的标题');
});

it('双方都改同一 Notes 时整包不写入，包括包内其他新增对象', async () => {
  const { sender, receiver, line, receipt } = await pair();
  for (const peer of [sender, receiver]) {
    const note = (await peer.service.execute({ type: 'notes.read', id: line.data.id })) as {
      body: string;
      revision: string;
    };
    await peer.service.execute({
      type: 'notes.save',
      id: line.data.id,
      revision: note.revision,
      body: note.body + peer.root,
    });
  }
  await sender.service.saveRecord(createRecord('project', { title: '冲突时也不能部分创建' }));
  const delta = await sender.send(receipt),
    before = await receiver.service.snapshot();
  expect((await receiver.preview(delta)).rows.some((row) => row.status === 'conflict')).toBe(true);
  await expect(receiver.apply(delta)).rejects.toThrow('冲突');
  expect((await receiver.service.snapshot()).entries).toEqual(before.entries);
});

it.each(['todo', 'milestone'] as const)(
  '增量保留 %s 升线的 UUID，并联合迁移 Notes 与关联',
  async (type) => {
    const { sender, receiver, todo, receipt } = await pair();
    const targetId =
      type === 'todo' ? todo.data.id : (todo.data as { milestoneId: string }).milestoneId;
    const target = (await sender.service.snapshot()).entries.find(
      (entry) => entry.data.id === targetId,
    )!;
    await sender.service.execute({ type: 'work.promote', id: targetId, revision: target.revision });
    const result = await receiver.apply(await sender.send(receipt));
    const after = await receiver.service.snapshot();
    expect(after.issues).toEqual([]);
    expect(after.entries.find((entry) => entry.data.id === targetId)!.data.type).toBe('workline');
    expect((await sender.send(result.receipt)).changes).toHaveLength(0);
  },
);

it('预览绑定本机版本与包内容，拒绝预览后写入和替换包', async () => {
  const { sender, receiver, project, receipt } = await pair();
  const extra = await sender.service.saveRecord(createRecord('project', { title: '新增一项' }));
  const delta = await sender.send(receipt),
    preview = await receiver.preview(delta);
  await sender.service.saveRecord({ ...extra.data, title: '替换包' }, extra.revision);
  await expect(receiver.apply(await sender.send(receipt), preview.revision)).rejects.toThrow(
    '预览',
  );
  const current = (await receiver.service.snapshot()).entries.find(
    (entry) => entry.data.id === project.data.id,
  )!;
  await receiver.service.saveRecord({ ...current.data, title: '预览后改动' }, current.revision);
  await expect(receiver.apply(delta, preview.revision)).rejects.toThrow('预览');
});

it('无共同对象不能导入孤立增量；发送端删除只提示，接收端删除不复活', async () => {
  const { sender, receiver, todo, receipt } = await pair();
  const current = (await sender.service.snapshot()).entries.find(
    (entry) => entry.data.id === todo.data.id,
  )!;
  await sender.service.saveRecord({ ...current.data, title: '变更待办' }, current.revision);
  const delta = await sender.send(receipt),
    unpaired = await empty();
  expect((await unpaired.preview(delta)).errors.length).toBeGreaterThan(0);
  await expect(unpaired.apply(delta)).rejects.toThrow('缺失');
  const target = (await receiver.service.snapshot()).entries.find(
    (entry) => entry.data.id === todo.data.id,
  )!;
  await receiver.service.execute({
    type: 'work.delete',
    id: target.data.id,
    expectations: { [target.data.id]: target.revision },
  });
  expect(
    (await receiver.preview(delta)).rows.find((row) => row.id === todo.data.id)!.reason,
  ).toContain('禁止自动复活');
  const deleted = (await sender.service.execute({
    type: 'work.deletePreview',
    id: todo.data.id,
  })) as { entries: { data: { id: string }; revision: string }[] };
  await sender.service.execute({
    type: 'work.delete',
    id: todo.data.id,
    expectations: Object.fromEntries(
      deleted.entries.map((entry) => [entry.data.id, entry.revision]),
    ),
  });
  expect((await sender.send(receipt)).missingIds).toContain(todo.data.id);
});

it('保留接收端非系统 YAML，不让交换数据指定 Notes 文件路径；重复 ID 和内容损坏被拒绝', async () => {
  const { sender, receiver, project, first, receipt } = await pair();
  const local = (await receiver.service.snapshot()).entries.find(
    (entry) => entry.data.id === project.data.id,
  )!;
  const file = path.join(receiver.root, local.path),
    source = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, '\ufeff' + source.replace('---\n', '---\ncustom: keep # comment\n'));
  await sender.service.saveRecord({ ...project.data, title: '更新标题' }, project.revision);
  await receiver.apply(await sender.send(receipt));
  const updated = await fs.readFile(file, 'utf8');
  expect(updated).toContain('custom: keep # comment\n');
  expect(updated.charCodeAt(0)).toBe(0xfeff);
  const broken = structuredClone(first);
  broken.changes[0].body += '篡改';
  await expect(receiver.preview(broken)).rejects.toThrow('校验');
  const { checksum: _checksum, ...payload } = first;
  await expect(
    receiver.preview(
      await sealExchange({ ...payload, changes: [...payload.changes, payload.changes[0]] }),
    ),
  ).rejects.toThrow('重复');
  const note = payload.changes.find((change) => change.data.type === 'resource')!;
  const evil = { ...note, data: { ...note.data, target: '../../outside.md' } };
  await expect(
    parseExchange(
      await sealExchange({
        ...payload,
        changes: payload.changes.map((change) => (change === note ? evil : change)),
      }),
    ),
  ).rejects.toThrow();
});

it('JSON 版本、大小、包与对象校验独立检查；同名新 UUID 仅推荐不合并', async () => {
  const { sender, receiver, receipt } = await pair();
  await sender.service.saveRecord(createRecord('project', { title: '跨端项目' }));
  const delta = await sender.send(receipt),
    plan = await receiver.preview(delta);
  expect(plan.rows.find((row) => row.status === 'create')!.candidates).toHaveLength(1);
  await expect(parseExchange({ ...delta, version: 2 })).rejects.toThrow();
  await expect(parseExchange({ padding: 'x'.repeat(exchangeMaxBytes) })).rejects.toThrow('512');
  const { checksum: _checksum, ...payload } = delta;
  const changes = payload.changes.map((change) => ({ ...change, body: change.body + '坏正文' }));
  const validEnvelope = await sealExchange({ ...payload, changes });
  expect(await exchangeHash({ test: 1 })).toMatch(/^[a-f0-9]{64}$/);
  await expect(receiver.preview(validEnvelope)).rejects.toThrow('对象内容校验');
});
