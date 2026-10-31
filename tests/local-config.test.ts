import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLocalConfig, rememberVault } from '../apps/local-service/src/local-config';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function configFile() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-config-'));
  roots.push(root);
  return path.join(root, '.chaos.local.json');
}

it('首次启动无需配置；保存及重新读取工作目录，不产生临时文件残留', async () => {
  const filename = await configFile();
  expect(await readLocalConfig(filename)).toEqual({});
  await expect(fs.stat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
  await rememberVault(filename, path.dirname(filename));
  expect(await readLocalConfig(filename)).toEqual({ vaultPath: path.dirname(filename) });
  await fs.writeFile(
    filename,
    JSON.stringify({ vaultPath: path.dirname(filename), custom: '保留' }),
  );
  const second = path.join(path.dirname(filename), '另一目录');
  await rememberVault(filename, second);
  expect(await readLocalConfig(filename)).toEqual({ vaultPath: second, custom: '保留' });
  expect(await fs.readdir(path.dirname(filename))).toEqual(['.chaos.local.json']);
});

it('配置损坏或目录不是绝对路径时拒绝覆盖，保留用户原文', async () => {
  const filename = await configFile();
  await expect(rememberVault(filename, './relative')).rejects.toThrow('绝对路径');
  const raw = '{broken config';
  await fs.writeFile(filename, raw);
  await expect(readLocalConfig(filename)).rejects.toThrow();
  await expect(rememberVault(filename, path.dirname(filename))).rejects.toThrow();
  expect(await fs.readFile(filename, 'utf8')).toBe(raw);
});
