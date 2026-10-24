import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vault } from '../apps/local-service/src/vault';
import { parseRecord } from '../packages/domain/index';

let vault: Vault | undefined;
afterEach(async () => {
  if (!vault) return;
  await vault.close();
  await fs.rm(vault.root, { recursive: true, force: true });
  vault = undefined;
});

it('只保留三份手动快照，编辑、删除和恢复不产生操作备份', async () => {
  vault = await Vault.open(await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-manual-backup-')));
  let entry = await vault.save(
    parseRecord({
      schemaVersion: 1,
      type: 'project',
      id: randomUUID(),
      title: '项目',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    entry = await vault.save({ ...entry.data, title: `版本 ${i}` }, entry.revision);
    ids.push((await vault.backup()).id);
  }
  const backups = await vault.backups();
  expect(backups).toHaveLength(3);
  expect(backups.some((b) => b.id === ids[0] || b.id === ids[1])).toBe(false);
  const manual = ids[4];
  const original = await fs.readFile(path.join(vault.root, entry.path), 'utf8');
  entry = await vault.save({ ...entry.data, title: '编辑后的版本' }, entry.revision);
  expect(await vault.backups()).toEqual(backups);
  await vault.restore(manual, { [entry.data.id]: entry.revision });
  expect(await fs.readFile(path.join(vault.root, entry.path), 'utf8')).toBe(original);
  expect(await vault.backups()).toEqual(backups);
  const preview = await vault.deletePreview(entry.data.id);
  await vault.deleteSpace(
    entry.data.id,
    Object.fromEntries(preview.entries.map((e) => [e.data.id, e.revision])),
  );
  expect((await vault.scan()).entries).toEqual([]);
  expect(await vault.backups()).toEqual(backups);
  await expect(fs.stat(path.join(vault.root, '.atlas/trash'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await vault.restore(manual, {});
  expect(await fs.readFile(path.join(vault.root, entry.path), 'utf8')).toBe(original);
});
