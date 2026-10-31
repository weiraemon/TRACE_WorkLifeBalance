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
    env: { ...process.env, ATLAS_PORT: String(port), ATLAS_CONFIG_PATH: config },
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
