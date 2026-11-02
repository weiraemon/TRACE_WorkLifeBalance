import { afterEach, expect, it, vi } from 'vitest';
import { recordContract } from '../packages/domain/index';
import { api, load, save, session } from '../apps/web/src/api';

afterEach(() => vi.unstubAllGlobals());

it.each([null, 'atlas-other-contract'])(
  '旧服务或契约不匹配时给出重启说明（%s）',
  async (contract) => {
    const response = new Response(JSON.stringify({ error: '旧类型校验错误' }), {
      status: 400,
      headers: contract ? { 'X-Atlas-Contract': contract } : {},
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(api('business/v1/commands', { data: { type: 'project' } })).rejects.toThrow(
      'Ctrl+C',
    );
  },
);

it('当前服务正常读取响应并禁用缓存，业务错误照常显示', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ connected: false }), {
        headers: { 'X-Atlas-Contract': recordContract },
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: '外部修改冲突' }), {
        status: 409,
        headers: { 'X-Atlas-Contract': recordContract },
      }),
    );
  vi.stubGlobal('fetch', request);
  await expect(api('session')).resolves.toEqual({ connected: false });
  expect(request).toHaveBeenCalledWith(
    '/api/session',
    expect.objectContaining({ cache: 'no-store' }),
  );
  await expect(api('business/v1/commands', {})).rejects.toThrow('外部修改冲突');
});

it('网页从标准业务接口读取和保存，保留会话校验与版本冲突', async () => {
  const snapshot = { entries: [], files: [], issues: [], root: 'test', vaultId: 'vault' };
  const data = { type: 'project' } as Parameters<typeof save>[0];
  const response = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'X-Atlas-Contract': recordContract },
    });
  const request = vi
    .fn()
    .mockResolvedValueOnce(response({ token: 'session-token', vaultId: 'vault', connected: true }))
    .mockResolvedValueOnce(response({ version: '1', snapshot }))
    .mockResolvedValueOnce(response({ version: '1', result: { data, revision: 'new' } }))
    .mockResolvedValueOnce(response({ error: '外部修改冲突' }, 409));
  vi.stubGlobal('fetch', request);
  await session();
  await expect(load()).resolves.toEqual(snapshot);
  await expect(save(data)).resolves.toEqual({ data, revision: 'new' });
  expect(request).toHaveBeenNthCalledWith(
    2,
    '/api/business/v1/workspace',
    expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({
        'X-Atlas-Token': 'session-token',
        'X-Atlas-Vault': 'vault',
      }),
    }),
  );
  expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({ type: 'record.save', data });
  await expect(save(data)).rejects.toThrow('外部修改冲突');
});

it('不解包未知版本的业务响应', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: '2',
          snapshot: { entries: [] },
        }),
        { headers: { 'X-Atlas-Contract': recordContract } },
      ),
    ),
  );
  await expect(load()).rejects.toThrow('业务接口版本不一致');
});
