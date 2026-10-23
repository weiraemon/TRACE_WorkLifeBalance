import { it, expect } from 'vitest';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

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
          env: { ...process.env, ATLAS_PORT: String(port) },
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
