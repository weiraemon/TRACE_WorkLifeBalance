import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverQq } from '../apps/desktop/qq-discovery';

it('从上级目录发现多个真实账号数据库，去重并忽略无数据库和无账号目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-discovery-'));
  try {
    for (const account of ['123456', '987654', 'not-account']) {
      const dir = path.join(root, 'Tencent Files', account, 'nt_qq', 'nt_db');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'nt_msg.db'), 'fixture');
    }
    await fs.mkdir(path.join(root, 'Tencent Files', '333333'), { recursive: true });
    const result = await discoverQq([root, root, path.join(root, 'missing')]);
    expect(result.accounts.map((a) => a.selfQQ).sort()).toEqual(['123456', '987654']);
    expect(result.limited).toBe(false);
    const direct = await discoverQq([result.accounts[0].dataDir]);
    expect(direct.accounts).toEqual([result.accounts[0]]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('不越过有限搜索深度，并提示选择更接近数据的目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-discovery-'));
  try {
    const dir = path.join(root, 'a', 'b', 'c', 'd', 'e', 'f', '123456', 'nt_db');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'nt_msg.db'), 'fixture');
    const result = await discoverQq([root]);
    expect(result.accounts).toEqual([]);
    expect(result.limited).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
