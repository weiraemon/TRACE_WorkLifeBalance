import { afterEach, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vault } from '../apps/local-service/src/native/vault';
import { parseRecord } from '../packages/domain/index';
import { emptyInbox, type Candidate } from '../packages/domain/messages';
const roots: string[] = [],
  vaults: Vault[] = [];
afterEach(async () => {
  for (const v of vaults.splice(0)) await v.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-messages-'));
  roots.push(root);
  const vault = await Vault.open(root);
  vaults.push(vault);
  const make = (type: string, fields: object) =>
    parseRecord({
      schemaVersion: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      type,
      ...fields,
    });
  const project = await vault.save(make('project', { title: '学业' }));
  const line = await vault.save(make('workline', { title: '通知', projectId: project.data.id }));
  const candidate: Candidate = {
    id: randomUUID(),
    fingerprint: 'a'.repeat(64),
    raw: false,
    conversation: '年级群',
    projectId: null,
    lineId: line.data.id,
    receivedAt: new Date().toISOString(),
    source: {
      ruleId: randomUUID(),
      sender: '老师',
      sentAt: '2026-10-28T08:00:00+08:00',
      text: '周五交报名表',
      context: '',
      atAll: true,
      atMe: false,
      remoteId: null,
      fromSelf: false,
    },
    suggestion: {
      kind: 'task',
      targetId: null,
      completed: false,
      title: '报名',
      dueDate: '2026-10-30',
      dueTime: '17:00',
      reason: '通知',
      uncertainty: '',
      actions: ['准备材料', '提交报名表'],
      tags: ['报告'],
      location: '教务办公室',
    },
  };
  const state = emptyInbox();
  state.candidates.push(candidate);
  await vault.saveMessageInbox(state, null);
  return { vault, candidate, line, project };
}
it('确认后节点、TODO、Notes 和移出收集箱共同落盘，重复确认不重复建任务', async () => {
  const { vault, candidate, line } = await setup();
  const inbox = await vault.messageInbox();
  await vault.acceptMessage(candidate.id, inbox.revision, line.data.id, candidate.suggestion);
  const entries = (await vault.scan()).entries;
  expect(entries.filter((e) => e.data.type === 'todo')).toHaveLength(2);
  expect(entries.filter((e) => e.data.type === 'actual')).toHaveLength(0);
  const node = entries.find((e) => e.data.type === 'milestone' && !e.data.pool)!;
  expect(node.data).toMatchObject({
    dueDate: '2026-10-30',
    dueTime: '17:00',
    tags: ['报告'],
    location: '教务办公室',
  });
  const note = await vault.readContent(node.data.id);
  expect(JSON.stringify(note).match(/周五交报名表/g)).toHaveLength(1);
  expect(JSON.stringify(note)).toContain('地点：教务办公室');
  expect((await vault.messageInbox()).state.candidates).toHaveLength(0);
  await expect(
    vault.acceptMessage(candidate.id, inbox.revision, line.data.id, candidate.suggestion),
  ).rejects.toThrow('更改');
});
it('确认变更后直接修改原节点日期并移出收集箱', async () => {
  const { vault, candidate, line } = await setup();
  const first = await vault.messageInbox();
  await vault.acceptMessage(candidate.id, first.revision, line.data.id, candidate.suggestion);
  const entries = (await vault.scan()).entries;
  const node = entries.find((e) => e.data.type === 'milestone' && !e.data.pool)!;
  const inbox = await vault.messageInbox();
  const change: Candidate = {
    ...candidate,
    id: randomUUID(),
    fingerprint: 'b'.repeat(64),
    raw: false,
    suggestion: {
      kind: 'change',
      targetId: node.data.id,
      completed: false,
      title: '报名',
      dueDate: '2026-11-01',
      dueTime: null,
      reason: '提交时间改到 11 月 1 日',
      uncertainty: '',
      actions: [],
      tags: [],
      location: null,
    },
  };
  inbox.state.candidates.push(change);
  await vault.saveMessageInbox(inbox.state, inbox.revision);
  const pending = await vault.messageInbox();
  await vault.acceptMessage(change.id, pending.revision, '', change.suggestion);
  const updated = (await vault.scan()).entries.find((e) => e.data.id === node.data.id)!;
  expect(updated.data).toMatchObject({ dueDate: '2026-11-01', dueTime: null });
  expect((await vault.messageInbox()).state.candidates).toHaveLength(0);
});
it('确认完成变更后标记原节点完成且不清空日期', async () => {
  const { vault, candidate, line } = await setup();
  const first = await vault.messageInbox();
  await vault.acceptMessage(candidate.id, first.revision, line.data.id, candidate.suggestion);
  const entries = (await vault.scan()).entries;
  const node = entries.find((e) => e.data.type === 'milestone' && !e.data.pool)!;
  const inbox = await vault.messageInbox();
  const done: Candidate = {
    ...candidate,
    id: randomUUID(),
    fingerprint: 'c'.repeat(64),
    raw: false,
    suggestion: {
      kind: 'change',
      targetId: node.data.id,
      completed: true,
      title: '报名',
      dueDate: null,
      dueTime: null,
      reason: '已经完成',
      uncertainty: '',
      actions: [],
      tags: [],
      location: null,
    },
  };
  inbox.state.candidates.push(done);
  await vault.saveMessageInbox(inbox.state, inbox.revision);
  const pending = await vault.messageInbox();
  await vault.acceptMessage(done.id, pending.revision, '', done.suggestion);
  const updated = (await vault.scan()).entries.find((e) => e.data.id === node.data.id)!;
  expect(updated.data.type).toBe('milestone');
  if (updated.data.type === 'milestone') expect(updated.data.completedAt).not.toBeNull();
  expect(updated.data).toMatchObject({ dueDate: '2026-10-30', dueTime: '17:00' });
});
it('手动只选项目不选业务线时，在该项目下新建业务线', async () => {
  const { vault, candidate, project } = await setup();
  const inbox = await vault.messageInbox();
  await vault.acceptMessage(
    candidate.id,
    inbox.revision,
    '',
    { ...candidate.suggestion, dueTime: null, actions: [], destination: null },
    project.data.id,
  );
  const entries = (await vault.scan()).entries;
  const node = entries.find(
    (e) =>
      e.data.type === 'milestone' && !e.data.pool && e.data.title === candidate.suggestion.title,
  )!;
  const nodeData = node.data;
  expect(nodeData.type).toBe('milestone');
  if (nodeData.type !== 'milestone') throw new Error('node not found');
  const line = entries.find((e) => e.data.type === 'workline' && e.data.id === nodeData.lineId)!;
  expect(line.data.type).toBe('workline');
  if (line.data.type !== 'workline') throw new Error('line not found');
  expect(line.data.projectId).toBe(project.data.id);
  expect(
    entries.some((e) => e.data.type === 'project' && e.data.title === candidate.suggestion.title),
  ).toBe(false);
});
it('只有日期没有时刻的任务也建立节点，而不是进入待办池', async () => {
  const { vault, candidate, line } = await setup();
  const inbox = await vault.messageInbox();
  await vault.acceptMessage(candidate.id, inbox.revision, line.data.id, {
    ...candidate.suggestion,
    dueTime: null,
    actions: [],
  });
  const entries = (await vault.scan()).entries;
  expect(
    entries.some(
      (e) =>
        e.data.type === 'milestone' &&
        !e.data.pool &&
        e.data.title === candidate.suggestion.title &&
        e.data.dueDate === '2026-10-30',
    ),
  ).toBe(true);
});
it('无日期行动进入原线待办池，不补今天', async () => {
  const { vault, candidate, line } = await setup();
  const inbox = await vault.messageInbox();
  await vault.acceptMessage(candidate.id, inbox.revision, line.data.id, {
    ...candidate.suggestion,
    dueDate: null,
    dueTime: null,
  });
  const entries = (await vault.scan()).entries;
  const pool = entries.find((e) => e.data.type === 'milestone' && e.data.pool)!;
  expect(
    entries
      .filter((e) => e.data.type === 'todo')
      .every(
        (e) =>
          e.data.type === 'todo' && e.data.dueDate === null && e.data.milestoneId === pool.data.id,
      ),
  ).toBe(true);
});
it('外部编辑收集箱时拒绝覆盖，规则与待确认事项可重启读取', async () => {
  const { vault } = await setup();
  const inbox = await vault.messageInbox();
  await fs.appendFile(path.join(vault.root, '.atlas/qq-inbox.md'), '\n外部备注\n');
  await expect(vault.saveMessageInbox(inbox.state, inbox.revision)).rejects.toThrow('更改');
  expect((await vault.messageInbox()).source).toContain('外部备注');
});
it('取消建议不能创建计划', async () => {
  const { vault, candidate, line } = await setup();
  const inbox = await vault.messageInbox();
  await expect(
    vault.acceptMessage(candidate.id, inbox.revision, line.data.id, {
      ...candidate.suggestion,
      kind: 'cancel',
    }),
  ).rejects.toThrow('核对');
  expect((await vault.messageInbox()).state.candidates).toHaveLength(1);
});
it('没有默认归属时按推荐新建项目与业务线，并复用同名归属', async () => {
  const { vault } = await setup();
  const first = await vault.messageInbox();
  const candidate = first.state.candidates[0];
  const destination = {
    kind: 'newProject' as const,
    projectTitle: '科研',
    lineTitle: '论文',
    reason: '与现有学业无关',
  };
  await vault.acceptMessage(candidate.id, first.revision, '', {
    ...candidate.suggestion,
    destination,
  });
  let entries = (await vault.scan()).entries;
  const project = entries.find((e) => e.data.type === 'project' && e.data.title === '科研');
  const line = entries.find((e) => e.data.type === 'workline' && e.data.title === '论文');
  expect(project).toBeTruthy();
  expect(line?.data).toMatchObject({ projectId: project!.data.id });
  expect(entries.filter((e) => e.data.type === 'todo')).toHaveLength(2);
  expect((await vault.readContent(line!.data.id)).body).toContain('周五交报名表');

  // A later message recommending the same names reuses the new project/line.
  const second = await vault.messageInbox();
  second.state.candidates.push({
    ...candidate,
    id: randomUUID(),
    fingerprint: 'c'.repeat(64),
    raw: false,
    lineId: null,
    suggestion: { ...candidate.suggestion, title: '另一份材料', destination },
  });
  await vault.saveMessageInbox(second.state, second.revision);
  const saved = await vault.messageInbox();
  await vault.acceptMessage(
    saved.state.candidates[0].id,
    saved.revision,
    '',
    saved.state.candidates[0].suggestion,
  );
  entries = (await vault.scan()).entries;
  expect(entries.filter((e) => e.data.type === 'project' && e.data.title === '科研')).toHaveLength(
    1,
  );
  expect(entries.filter((e) => e.data.type === 'workline' && e.data.title === '论文')).toHaveLength(
    1,
  );
  const nodes = new Set(
    entries
      .filter((e) => e.data.type === 'milestone' && e.data.lineId === line!.data.id)
      .map((e) => e.data.id),
  );
  expect(
    entries.filter((e) => e.data.type === 'todo' && nodes.has(e.data.milestoneId)),
  ).toHaveLength(4);
});
it('可在指定项目下新建业务线；失效推荐自动改为按标题新建归属', async () => {
  const { vault, line } = await setup();
  const inbox = await vault.messageInbox();
  const candidate = inbox.state.candidates[0];
  const entries = (await vault.scan()).entries;
  const project = entries.find((e) => e.data.type === 'project')!;
  await vault.acceptMessage(candidate.id, inbox.revision, '', {
    ...candidate.suggestion,
    destination: {
      kind: 'newLine',
      projectId: project.data.id,
      lineTitle: '课程事务',
      reason: '同一项目下的新主线',
    },
  });
  const created = (await vault.scan()).entries.find(
    (e) => e.data.type === 'workline' && e.data.title === '课程事务',
  );
  expect(created?.data).toMatchObject({ projectId: project.data.id });
  expect(created?.data.id).not.toBe(line.data.id);

  const third = await vault.messageInbox();
  third.state.candidates.push({
    ...candidate,
    id: randomUUID(),
    fingerprint: 'd'.repeat(64),
    lineId: null,
  });
  await vault.saveMessageInbox(third.state, third.revision);
  const saved = await vault.messageInbox();
  await vault.acceptMessage(saved.state.candidates[0].id, saved.revision, '', {
    ...saved.state.candidates[0].suggestion,
    destination: { kind: 'newLine', projectId: randomUUID(), lineTitle: '无效线', reason: '' },
  });
  const after = (await vault.scan()).entries;
  expect(after.some((e) => e.data.type === 'project' && e.data.title === '报名')).toBe(true);
  expect(after.some((e) => e.data.type === 'workline' && e.data.title === '报名')).toBe(true);
});
it('限定项目的会话只在项目下新建业务线，不创建新项目', async () => {
  const { vault } = await setup();
  const project = (await vault.scan()).entries.find((e) => e.data.type === 'project')!;
  const inbox = await vault.messageInbox();
  const candidate = inbox.state.candidates[0];
  inbox.state.candidates[0] = {
    ...candidate,
    projectId: project.data.id,
    lineId: null,
    suggestion: {
      ...candidate.suggestion,
      title: '报名材料',
      destination: {
        kind: 'newProject',
        projectTitle: '不应出现的项目',
        lineTitle: '报名材料',
        reason: '模型误判',
      },
    },
  };
  await vault.saveMessageInbox(inbox.state, inbox.revision);
  const saved = await vault.messageInbox();
  await vault.acceptMessage(
    saved.state.candidates[0].id,
    saved.revision,
    '',
    saved.state.candidates[0].suggestion,
  );
  const after = (await vault.scan()).entries;
  expect(after.some((e) => e.data.type === 'project' && e.data.title === '不应出现的项目')).toBe(
    false,
  );
  expect(
    after.some(
      (e) =>
        e.data.type === 'workline' &&
        e.data.title === '报名材料' &&
        e.data.projectId === project.data.id,
    ),
  ).toBe(true);
});
