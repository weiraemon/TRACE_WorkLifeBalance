import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Vault } from '../apps/local-service/src/native/vault';

const roots: string[] = [];
const opened: Vault[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const vault of opened.splice(0)) await vault.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(lock: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-lock-'));
  roots.push(root);
  await fs.mkdir(path.join(root, '.atlas'));
  await fs.writeFile(path.join(root, '.atlas/service.lock'), lock);
  await fs.writeFile(path.join(root, 'personal.md'), 'User notes stay untouched.');
  return root;
}
it('recovers an abandoned lock without changing user notes', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  const root = await fixture(JSON.stringify({ pid: child.pid, token: 'old' }));
  const vault = await Vault.open(root);
  opened.push(vault);
  expect(
    JSON.parse(await fs.readFile(path.join(root, '.atlas/service.lock'), 'utf8')).token,
  ).not.toBe('old');
  expect(await fs.readFile(path.join(root, 'personal.md'), 'utf8')).toBe(
    'User notes stay untouched.',
  );
});
it.each(['alive', 'permission', 'malformed'])('preserves uncertain locks: %s', async (kind) => {
  const original = kind === 'malformed' ? '{' : JSON.stringify({ pid: process.pid, token: 'old' });
  const root = await fixture(original);
  if (kind === 'permission')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
  await expect(Vault.open(root)).rejects.toThrow('已由');
  expect(await fs.readFile(path.join(root, '.atlas/service.lock'), 'utf8')).toBe(original);
});
it('allows only one concurrent recovery to own the directory', async () => {
  const root = await fixture(JSON.stringify({ pid: 123456, token: 'old' }));
  const realKill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === 123456) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return realKill(pid, signal);
  });
  const results = await Promise.allSettled([Vault.open(root), Vault.open(root)]);
  for (const result of results) if (result.status === 'fulfilled') opened.push(result.value);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
});
