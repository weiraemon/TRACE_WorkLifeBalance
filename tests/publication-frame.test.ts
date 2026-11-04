import { expect, it, vi } from 'vitest';
import type { Snapshot } from '../packages/domain/index';

const snapshot = (vaultId: string): Snapshot => ({
  vaultId,
  root: vaultId,
  entries: [],
  files: [],
  issues: [],
});

it('已发布快照只用于紧随写入的一次刷新，后续刷新继续读取目录', async () => {
  vi.resetModules();
  const http = await import('../apps/web/src/platform/http');
  let reads = 0;
  http.installPlatformTransport(async (route) => {
    if (route === 'session') return { token: '', vaultId: 'a' };
    if (route.endsWith('commands')) return { version: '1', result: {}, snapshot: snapshot('a') };
    reads++;
    return { version: '1', snapshot: snapshot('a') };
  });
  await http.session();
  await http.businessRequest('commands', { type: 'notes.read', id: crypto.randomUUID() });
  expect((await http.businessRequest<{ snapshot: Snapshot }>('workspace')).snapshot.vaultId).toBe(
    'a',
  );
  expect(reads).toBe(0);
  await http.businessRequest('workspace');
  expect(reads).toBe(1);
});

it('切换目录和迟到的旧命令不能交付旧目录快照', async () => {
  vi.resetModules();
  const http = await import('../apps/web/src/platform/http');
  let resolveOld!: (value: unknown) => void;
  let commands = 0,
    reads = 0;
  http.installPlatformTransport(async (route) => {
    if (route === 'session') return { token: '', vaultId: 'a' };
    if (route === 'connect') return snapshot('b');
    if (route.endsWith('commands') && commands++ === 0)
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    if (route.endsWith('commands')) return { version: '1', result: {}, snapshot: snapshot('b') };
    reads++;
    return { version: '1', snapshot: snapshot('b') };
  });
  await http.session();
  const old = http.businessRequest('commands', { type: 'notes.read', id: crypto.randomUUID() });
  await http.api('connect', {});
  await http.businessRequest('commands', { type: 'notes.read', id: crypto.randomUUID() });
  resolveOld({ version: '1', result: {}, snapshot: snapshot('a') });
  await old;
  expect((await http.businessRequest<{ snapshot: Snapshot }>('workspace')).snapshot.vaultId).toBe(
    'b',
  );
  expect(reads).toBe(0);
});
