import { afterEach, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vault } from '../apps/local-service/src/native/vault';
import { workspaceServiceFor } from '../apps/local-service/src/application/workspace-service';
import { messageServiceFor } from '../apps/local-service/src/application/message-inbox-service';
import { intakeServiceFor } from '../apps/local-service/src/application/message-intake-service';
import { saveAiConfig } from '../apps/local-service/src/sync/app-config';
import { parseRecord } from '../packages/domain/index';
import { isComplete } from '../packages/domain/workspace';
import { emptyInbox, messageSettingsSchema } from '../packages/domain/messages';
const roots: string[] = [];
const opened: Vault[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const vault of opened.splice(0)) await vault.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-business-'));
  roots.push(root);
  const vault = await Vault.open(root);
  opened.push(vault);
  const business = workspaceServiceFor(vault);
  const make = (type: string, fields: object) =>
    parseRecord({
      schemaVersion: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      type,
      ...fields,
    });
  const project = await business.saveRecord(make('project', { title: '通用 API 项目' }));
  const line = await business.saveRecord(
    make('workline', { title: '通用 API 业务', projectId: project.data.id }),
  );
  return { root, vault, business, project, line };
}
it('标准命令创建计划、改期和完成复用 main 的待办池、Notes 与完成推导', async () => {
  const { vault, business, project, line } = await setup();
  await business.execute({
    type: 'plan.create',
    plan: {
      kind: 'event',
      title: '外部安排',
      lineId: line.data.id,
      dueDate: '2026-11-02',
      actions: ['先检查', '再确认'],
      note: { id: randomUUID(), text: '来自任意客户端的原文', date: '2026-11-01' },
    },
  });
  let state = await business.snapshot();
  const node = state.entries.find((entry) => entry.data.type === 'milestone' && !entry.data.pool)!;
  const todo = state.entries.find((entry) => entry.data.type === 'todo')!;
  await business.execute({
    type: 'work.comment',
    id: todo.data.id,
    revision: todo.revision,
    text: '必须保留的条目批注',
  });
  const current = (await business.snapshot()).entries.find(
    (entry) => entry.data.id === todo.data.id,
  )!;
  await business.execute({
    type: 'work.reschedule',
    id: current.data.id,
    revision: current.revision,
    dueDate: '2026-11-03',
  });
  state = await business.snapshot();
  const moved = state.entries.find((entry) => entry.data.id === todo.data.id)!;
  expect(moved.data).toHaveProperty('dueDate', '2026-11-03');
  const pool = state.entries.find(
    (entry) => entry.data.id === (moved.data as { milestoneId: string }).milestoneId,
  )!;
  expect(pool.data).toHaveProperty('pool', true);
  expect((await vault.readContent(moved.data.id)).body).toContain('必须保留的条目批注');
  const latestNode = state.entries.find((entry) => entry.data.id === node.data.id)!;
  await business.execute({
    type: 'work.complete',
    id: node.data.id,
    revision: latestNode.revision,
    completed: true,
  });
  state = await business.snapshot();
  const completed = state.entries.find((entry) => entry.data.id === node.data.id)!.data;
  expect(isComplete(completed, state.entries)).toBe(true);
  expect(completed).toHaveProperty('completedAt', null);
  for (const id of [project.data.id, line.data.id, todo.data.id])
    expect(state.entries.find((entry) => entry.data.id === id)?.data).toHaveProperty(
      'completedAt',
      null,
    );
  expect((await vault.readContent(line.data.id)).body.split('来自任意客户端的原文')).toHaveLength(
    2,
  );
  expect(state.entries.some((entry) => entry.data.type === 'actual')).toBe(false);
});
it('接入元数据冲突时业务批次不发布，标准命令不允许传入存储路径', async () => {
  const { vault, business, line } = await setup();
  const before = (await business.snapshot()).entries;
  await expect(
    business.createPlan(
      {
        kind: 'event',
        title: '不能部分入库',
        destination: {
          kind: 'newProject',
          projectTitle: '不会创建',
          lineTitle: '不会创建',
          reason: '',
        },
      },
      [{ path: '.atlas/external.json', content: '{}', expected: '0'.repeat(64) }],
    ),
  ).rejects.toThrow('更改');
  expect((await business.snapshot()).entries).toEqual(before);
  await expect(
    business.execute({
      type: 'plan.create',
      plan: { kind: 'task', title: '非法写入', lineId: line.data.id },
      companions: [{ path: 'outside.md', content: 'bad', expected: null }],
    }),
  ).rejects.toThrow();
  const pool = before.find((entry) => entry.data.type === 'milestone' && entry.data.pool)!;
  await expect(
    business.execute({
      type: 'work.complete',
      id: pool.data.id,
      revision: pool.revision,
      completed: true,
    }),
  ).rejects.toThrow('待办池');
  await expect(fs.stat(path.join(vault.root, '.atlas/pending.json'))).rejects.toHaveProperty(
    'code',
    'ENOENT',
  );
});
it('AI 判断无需安排的消息也记住去重，第二次接收不再发送给模型', async () => {
  const { root, vault, business, line } = await setup();
  vi.stubEnv('CHAOS_CONFIG_DIR', path.join(root, 'app-config'));
  await saveAiConfig({
    provider: 'custom',
    baseUrl: 'https://example.invalid/v1',
    model: 'test',
    jsonMode: true,
    key: 'test-only',
  });
  const inbox = emptyInbox();
  const ruleId = randomUUID();
  inbox.settings = messageSettingsSchema.parse({
    names: [],
    classes: [],
    rules: [
      {
        id: ruleId,
        name: '通用消息源',
        kind: 'group',
        enabled: true,
        useAi: true,
        autoAccept: false,
        includeSelf: false,
        mode: 'all',
        conditions: [],
        senders: [],
        keywords: [],
        aliases: [],
        lineId: line.data.id,
      },
    ],
  });
  const messages = messageServiceFor(vault);
  await messages.saveMessageInbox(inbox, null);
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  suggestions: [
                    {
                      kind: 'ignore',
                      title: '无需安排',
                      dueDate: null,
                      dueTime: null,
                      reason: '问候消息',
                      uncertainty: '',
                      actions: [],
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  const source = {
    ruleId,
    sender: '外部客户端',
    sentAt: new Date().toISOString(),
    text: '你好，收到即可',
    atAll: false,
    atMe: false,
    remoteId: 'external-1',
  };
  await intakeServiceFor(vault).receive(source, (await messages.messageInbox()).revision);
  const current = await messages.messageInbox();
  expect(current.state.candidates).toHaveLength(0);
  expect(current.state.seen).toHaveLength(1);
  await intakeServiceFor(vault).receive(source, current.revision);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect((await business.snapshot()).entries.some((entry) => entry.data.type === 'todo')).toBe(
    false,
  );
});
