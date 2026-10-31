import { afterEach, it, expect } from 'vitest';
import net from 'node:net';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../../apps/local-service/src/server.ts', import.meta.url));

it.each([true, false])(
  '端口占用时明确提示并退出，不影响已有服务（production=%s）',
  async (production) => {
    const existing = net.createServer();
    await new Promise<void>((resolve) => existing.listen(0, '127.0.0.1', resolve));
    const port = (existing.address() as net.AddressInfo).port;
    try {
      const result = await execute(
        process.execPath,
        ['--import', 'tsx', entry, ...(production ? ['--production'] : [])],
        {
          env: {
            ...process.env,
            ATLAS_PORT: String(port),
            ATLAS_CONFIG_PATH: path.join(os.tmpdir(), `unused-${randomUUID()}.json`),
            CHAOS_CONFIG_DIR: path.join(os.tmpdir(), `chaos-unused-app-${randomUUID()}`),
          },
          timeout: 10000,
          windowsHide: true,
          encoding: 'utf8',
        },
      ).then(
        () => {
          throw new Error('重复启动应返回失败状态');
        },
        (error) => error,
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`http://127.0.0.1:${port} 已被占用`);
      expect(result.stderr).toContain('Ctrl+C');
      expect(result.stderr).not.toContain("Unhandled 'error' event");
      expect(existing.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        existing.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

const processes: ChildProcess[] = [];
const roots: string[] = [];
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}
afterEach(async () => {
  for (const child of processes.splice(0)) await stop(child);
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function start(config: string) {
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', entry, '--production'], {
    windowsHide: true,
    env: {
      ...process.env,
      ATLAS_PORT: String(port),
      ATLAS_CONFIG_PATH: config,
      CHAOS_CONFIG_DIR: config + '.app-config',
    },
  });
  processes.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const base = `http://127.0.0.1:${port}/api/`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(base + 'session');
      if (response.ok) return { child, base, session: await response.json() };
    } catch {}
    if (child.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('服务启动超时：' + output);
}

it('成功连接才记住目录；强制终止后自动恢复，活跃锁和失效路径安全回退', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-server-'));
  roots.push(root);
  const first = path.join(root, 'first'),
    second = path.join(root, 'second');
  await fs.mkdir(first);
  await fs.mkdir(second);
  const config = path.join(root, '.chaos.local.json');
  const missing = path.join(root, 'missing');
  const initial = await start(config);
  expect(initial.session).toMatchObject({ connected: false, root: '', connectionError: '' });
  const connect = (base: string, token: string, target: string) =>
    fetch(base + 'connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlas-Token': token },
      body: JSON.stringify({ path: target }),
    });
  expect((await connect(initial.base, initial.session.token, missing)).ok).toBe(false);
  await expect(fs.stat(config)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await connect(initial.base, initial.session.token, first)).ok).toBe(true);
  const connected = await connect(initial.base, initial.session.token, second).then((r) =>
    r.json(),
  );
  expect(connected.root).toBe(await fs.realpath(second));
  expect(JSON.parse(await fs.readFile(config, 'utf8')).vaultPath).toBe(connected.root);
  const now = new Date().toISOString();
  const saved = await fetch(initial.base + 'records', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Atlas-Token': initial.session.token,
      'X-Atlas-Vault': connected.vaultId,
    },
    body: JSON.stringify({
      data: {
        schemaVersion: 1,
        id: randomUUID(),
        type: 'project',
        title: '重启后仍保留',
        createdAt: now,
        updatedAt: now,
      },
    }),
  });
  expect(saved.ok).toBe(true);
  expect((await connect(initial.base, initial.session.token, missing)).ok).toBe(false);
  expect(JSON.parse(await fs.readFile(config, 'utf8')).vaultPath).toBe(connected.root);
  await stop(initial.child);
  await fs.access(path.join(second, '.atlas/service.lock'));

  const restored = await start(config);
  expect(restored.session).toMatchObject({
    connected: true,
    root: connected.root,
    connectionError: '',
  });
  const state = await fetch(restored.base + 'snapshot', {
    headers: {
      'X-Atlas-Token': restored.session.token,
      'X-Atlas-Vault': restored.session.vaultId,
    },
  }).then((r) => r.json());
  expect(state.entries[0].data).toMatchObject({ title: '重启后仍保留' });
  const before = await fs.readFile(path.join(second, '.atlas/service.lock'), 'utf8');
  const contender = await start(config);
  expect(contender.session).toMatchObject({ connected: false, root: connected.root });
  expect(contender.session.connectionError).toContain('已由');
  expect(await fs.readFile(path.join(second, '.atlas/service.lock'), 'utf8')).toBe(before);
  await stop(contender.child);
  await stop(restored.child);

  await fs.writeFile(config, JSON.stringify({ vaultPath: missing }));
  const unavailable = await start(config);
  expect(unavailable.session).toMatchObject({ connected: false, root: missing });
  expect(unavailable.session.connectionError).toContain('无法恢复');
  expect((await connect(unavailable.base, unavailable.session.token, first)).ok).toBe(true);
  expect(JSON.parse(await fs.readFile(config, 'utf8')).vaultPath).toBe(await fs.realpath(first));
}, 40000);

it('标准业务 API 与原网页路由共用状态、改期规则和 Notes，拒绝越权与过期版本', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-standard-api-'));
  roots.push(root);
  const work = path.join(root, 'work');
  await fs.mkdir(work);
  const started = await start(path.join(root, 'config.json'));
  const response = await fetch(started.base + 'connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Atlas-Token': started.session.token },
    body: JSON.stringify({ path: work }),
  });
  expect(response.ok).toBe(true);
  const connected = await response.json();
  const headers = {
    'Content-Type': 'application/json',
    'X-Atlas-Token': started.session.token,
    'X-Atlas-Vault': connected.vaultId,
  };
  const post = (route: string, payload: unknown) =>
    fetch(started.base + route, { method: 'POST', headers, body: JSON.stringify(payload) });
  const command = async (payload: unknown) => {
    const result = await post('business/v1/commands', payload);
    expect(result.ok, await result.clone().text()).toBe(true);
    const value = await result.json();
    expect(value.version).toBe('1');
    return value.result;
  };
  expect((await fetch(started.base + 'business/v1/workspace')).status).toBe(403);
  expect((await fetch(started.base + 'business/v1/schema')).status).toBe(403);
  const schema = await fetch(started.base + 'business/v1/schema', { headers }).then((result) =>
    result.json(),
  );
  expect(schema.version).toBe('1');
  expect(JSON.stringify(schema.schema)).toContain('work.complete');
  const make = (type: string, fields: object) => ({
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type,
    ...fields,
  });
  const project = await command({
    type: 'record.save',
    data: make('project', { title: 'API 项目' }),
  });
  const line = await command({
    type: 'record.save',
    data: make('workline', { title: 'API 业务', projectId: project.data.id }),
  });
  await command({
    type: 'plan.create',
    plan: {
      kind: 'event',
      title: '标准接口安排',
      lineId: line.data.id,
      dueDate: '2026-11-02',
      actions: ['准备材料', '参加讨论'],
      note: { id: randomUUID(), text: 'API 原文只保存一次', date: '2026-11-01' },
    },
  });
  let snapshot = await fetch(started.base + 'snapshot', { headers }).then((result) =>
    result.json(),
  );
  const todo = snapshot.entries.find((entry: any) => entry.data.type === 'todo');
  const node = snapshot.entries.find(
    (entry: any) => entry.data.type === 'milestone' && !entry.data.pool,
  );
  await command({
    type: 'work.reschedule',
    id: todo.data.id,
    revision: todo.revision,
    dueDate: '2026-11-03',
  });
  expect(
    (
      await post('business/v1/commands', {
        type: 'work.complete',
        id: todo.data.id,
        revision: todo.revision,
        completed: true,
      })
    ).status,
  ).toBe(409);
  snapshot = await fetch(started.base + 'snapshot', { headers }).then((result) => result.json());
  const moved = snapshot.entries.find((entry: any) => entry.data.id === todo.data.id);
  expect(
    snapshot.entries.find((entry: any) => entry.data.id === moved.data.milestoneId).data.pool,
  ).toBe(true);
  const latestNode = snapshot.entries.find((entry: any) => entry.data.id === node.data.id);
  await command({
    type: 'work.complete',
    id: node.data.id,
    revision: latestNode.revision,
    completed: true,
  });
  const oldNotes = await post('content', { action: 'read', id: line.data.id }).then((result) =>
    result.json(),
  );
  const standardNotes = await command({ type: 'notes.read', id: line.data.id });
  expect(standardNotes).toEqual(oldNotes);
  expect(oldNotes.body.split('API 原文只保存一次')).toHaveLength(2);
  const standard = await fetch(started.base + 'business/v1/workspace', { headers }).then((result) =>
    result.json(),
  );
  expect(standard.version).toBe('1');
  expect(standard.snapshot).toEqual(
    await fetch(started.base + 'snapshot', { headers }).then((result) => result.json()),
  );
  const before = standard.snapshot.entries;
  expect(
    (
      await post('business/v1/commands', {
        type: 'plan.create',
        plan: { kind: 'task', title: '不允许任意文件写入', lineId: line.data.id },
        companions: [{ path: 'outside.md', content: 'bad', expected: null }],
      })
    ).status,
  ).toBe(400);
  expect(
    (await fetch(started.base + 'snapshot', { headers }).then((result) => result.json())).entries,
  ).toEqual(before);
}, 30000);
