import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Vault } from '../apps/local-service/src/vault';

const roots: string[] = [];
const vaults: Vault[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  for (const vault of vaults.splice(0)) await vault.close().catch(() => {});
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-lock-'));
  roots.push(root);
  await fs.mkdir(path.join(root, '.atlas'));
  return root;
}
async function open(root: string) {
  const vault = await Vault.open(root);
  vaults.push(vault);
  return vault;
}

it('活跃服务的锁保持不变，正常关闭后可以重新打开', async () => {
  const root = await directory(),
    vault = await open(root);
  const filename = path.join(root, '.atlas/service.lock');
  const before = await fs.readFile(filename, 'utf8');
  await expect(Vault.open(root)).rejects.toThrow('已由');
  expect(await fs.readFile(filename, 'utf8')).toBe(before);
  await vault.close();
  await open(root);
});

it('真实进程被强制终止后，自动回收旧锁并保留已保存内容', async () => {
  const root = await directory();
  const moduleUrl = new URL('../apps/local-service/src/vault.ts', import.meta.url).href;
  const program = `import { Vault } from ${JSON.stringify(moduleUrl)};
    import { randomUUID } from 'node:crypto';
    const vault = await Vault.open(process.argv[1]);
    await vault.save({schemaVersion: 1, id: randomUUID(), type: 'project', title: '关机前保存的工作', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()});
    console.log('LOCKED'); setInterval(() => {}, 1000);`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', program, root],
    { windowsHide: true },
  );
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk) => {
      if (String(chunk).includes('LOCKED')) resolve();
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error(stderr || '锁持有进程提前退出')));
  });
  const filename = path.join(root, '.atlas/service.lock');
  const old = JSON.parse(await fs.readFile(filename, 'utf8'));
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  expect(JSON.parse(await fs.readFile(filename, 'utf8')).token).toBe(old.token);
  const reopened = await open(root);
  expect(JSON.parse(await fs.readFile(filename, 'utf8')).token).not.toBe(old.token);
  expect((await reopened.scan()).entries[0].data).toMatchObject({ title: '关机前保存的工作' });
});

it('同一 PID 被复用时，通过进程启动标识回收旧锁；同时连接只有一个成功', async () => {
  const root = await directory();
  await fs.writeFile(
    path.join(root, '.atlas/service.lock'),
    JSON.stringify({
      pid: process.pid,
      token: randomUUID(),
      host: os.hostname(),
      startedAt: '2000-01-01T00:00:00.000Z',
    }),
  );
  const attempts = await Promise.allSettled([Vault.open(root), Vault.open(root)]);
  const opened = attempts.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  vaults.push(...opened);
  expect(opened).toHaveLength(1);
  await expect(Vault.open(root)).rejects.toThrow('已由');
});

it('旧格式仍保护活跃服务；权限不足、损坏内容和外机锁均不擅自移除', async () => {
  const root = await directory();
  const filename = path.join(root, '.atlas/service.lock');
  const sources = [
    JSON.stringify({ pid: process.pid, token: randomUUID() }),
    '{unfinished',
    JSON.stringify({ pid: -1, token: randomUUID() }),
    JSON.stringify({ pid: process.pid, token: randomUUID(), host: os.hostname() + '-other' }),
  ];
  for (const source of sources) {
    await fs.writeFile(filename, source);
    await expect(Vault.open(root)).rejects.toThrow();
    expect(await fs.readFile(filename, 'utf8')).toBe(source);
  }
  await fs.writeFile(filename, sources[0]);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('禁止查询'), { code: 'EPERM' });
  });
  await expect(Vault.open(root)).rejects.toThrow('已由');
  expect(await fs.readFile(filename, 'utf8')).toBe(sources[0]);
});
