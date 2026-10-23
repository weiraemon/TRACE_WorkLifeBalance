import { afterEach, expect, it, vi } from 'vitest';
import { recordContract } from '../packages/domain/index';
import { api } from '../apps/web/src/api';

afterEach(() => vi.unstubAllGlobals());

it.each([null, 'atlas-other-contract'])(
  '旧服务或契约不匹配时给出重启说明（%s）',
  async (contract) => {
    const response = new Response(JSON.stringify({ error: '旧类型校验错误' }), {
      status: 400,
      headers: contract ? { 'X-Atlas-Contract': contract } : {},
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(api('records', { data: { type: 'project' } })).rejects.toThrow('Ctrl+C');
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
  await expect(api('records', {})).rejects.toThrow('外部修改冲突');
});
