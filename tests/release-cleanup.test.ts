import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

const moduleUrl = new URL('../scripts/package-desktop.mjs', import.meta.url);
const { pruneDesktopReleases } = await import(moduleUrl.href);
const testRoot = path.resolve('.test-vault');
const roots: string[] = [];
async function setup() {
  await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, 'release-cleanup-'));
  roots.push(root);
  const releases = path.join(root, 'releases');
  await fs.mkdir(releases);
  return { root, releases };
}
async function release(root: string, name: string, complete = true) {
  const directory = path.join(root, name);
  await fs.mkdir(directory);
  if (complete) await fs.writeFile(path.join(directory, 'CHAOS-Windows-x64.zip'), 'test ZIP');
  return directory;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(await fs.realpath(root))).toBe(await fs.realpath(testRoot));
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('成功打包后只保留指定的新产物，清理旧格式目录并保留无关内容', async () => {
  const { releases } = await setup();
  await release(releases, 'CHAOS-desktop');
  await release(releases, 'CHAOS-Windows-v0.1.0');
  await release(releases, 'CHAOS-desktop-failed', false);
  const keep = await release(releases, 'CHAOS-desktop-latest');
  await fs.mkdir(path.join(releases, 'personal-files'));
  await fs.writeFile(path.join(releases, 'readme.txt'), 'keep');
  expect(await pruneDesktopReleases(releases, keep)).toHaveLength(3);
  expect((await fs.readdir(releases)).sort()).toEqual([
    'CHAOS-desktop-latest',
    'personal-files',
    'readme.txt',
  ]);
});

it('新包未完成时不删除上一份可用包', async () => {
  const { releases } = await setup();
  const old = await release(releases, 'CHAOS-desktop-old');
  const incomplete = await release(releases, 'CHAOS-desktop-building', false);
  await expect(pruneDesktopReleases(releases, incomplete)).rejects.toThrow();
  expect(await fs.readFile(path.join(old, 'CHAOS-Windows-x64.zip'), 'utf8')).toBe('test ZIP');
  await fs.writeFile(path.join(incomplete, 'CHAOS-Windows-x64.zip'), '');
  await expect(pruneDesktopReleases(releases, incomplete)).rejects.toThrow('new ZIP is complete');
  expect(await fs.readdir(releases)).toHaveLength(2);
});

it('拒绝保留目录越界，清理前不触及外部目录', async () => {
  const { root, releases } = await setup();
  await release(releases, 'CHAOS-desktop-old');
  const outside = await release(root, 'CHAOS-desktop-outside');
  await expect(pruneDesktopReleases(releases, outside)).rejects.toThrow('directly inside releases');
  expect(await fs.readdir(releases)).toEqual(['CHAOS-desktop-old']);
  expect(await fs.readFile(path.join(outside, 'CHAOS-Windows-x64.zip'), 'utf8')).toBe('test ZIP');
});
