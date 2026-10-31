import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { Vault, VaultError } from './vault';
import { recordContract, saveOptionsSchema } from '../../../packages/domain/index';
import { readLocalConfig, rememberVault } from './local-config';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const port = Number(process.env.ATLAS_PORT ?? 4317);
const origin = `http://127.0.0.1:${port}`;
const configPath = path.resolve(
  process.env.ATLAS_CONFIG_PATH ?? path.join(project, '.chaos.local.json'),
);
const token = randomBytes(32).toString('hex');
let vault: Vault | undefined;
let switching = false;
let defaultRoot = '';
let connectionError = '';
let restoring: Promise<void> = Promise.resolve();
async function restoreConnection() {
  try {
    defaultRoot = (await readLocalConfig(configPath)).vaultPath ?? '';
    if (defaultRoot) vault = await Vault.open(defaultRoot);
  } catch (error) {
    connectionError = `无法恢复上次的工作目录：${error instanceof Error ? error.message : String(error)}`;
    console.error(connectionError);
  }
}
const production = process.argv.includes('--production');
const vite = production
  ? undefined
  : await (
      await import('vite')
    ).createServer({
      configFile: path.join(project, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
const send = (res: http.ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
};
const body = async (req: http.IncomingMessage): Promise<any> => {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new VaultError('请求超过 1 MB', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new VaultError('请求必须是 JSON');
  }
};
function nativeOpen(target: string) {
  // Never launch executables, scripts or arbitrary URI handlers from Vault contents.
  if (process.platform === 'win32') {
    // Environment transfer avoids shell interpolation of a document path.
    const script = 'Start-Process -FilePath $env:ATLAS_OPEN_TARGET';
    return new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        env: { ...process.env, ATLAS_OPEN_TARGET: target },
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new VaultError('操作系统未能打开资源')),
      );
    });
  }
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], {
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new VaultError('操作系统未能打开资源')),
    );
  });
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Atlas-Contract', recordContract);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
  );
  if (
    req.headers.host !== `127.0.0.1:${port}` ||
    (req.headers.origin && req.headers.origin !== origin)
  )
    return send(res, 403, { error: '仅允许本机同源访问' });
  const url = new URL(req.url ?? '/', origin);
  try {
    await restoring;
    if (url.pathname === '/api/session' && req.method === 'GET')
      return send(res, 200, {
        token,
        connected: Boolean(vault),
        root: vault?.root ?? defaultRoot,
        vaultId: vault?.sessionId ?? '',
        connectionError,
      });
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-atlas-token'] !== token)
        return send(res, 403, { error: '会话已失效，请刷新页面' });
      if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json'))
        throw new VaultError('仅接受 JSON');
      if (url.pathname === '/api/connect' && req.method === 'POST') {
        const input = z.object({ path: z.string().min(1) }).parse(await body(req));
        if (switching) throw new VaultError('Vault 正在切换，请稍后重试', 409);
        if (vault && path.resolve(input.path) === vault.root) {
          await vault.recover();
          await rememberVault(configPath, vault.root);
          connectionError = '';
          return send(res, 200, await vault.scan());
        }
        switching = true;
        try {
          const next = await Vault.open(input.path);
          try {
            await rememberVault(configPath, next.root);
            await vault?.close();
          } catch (error) {
            await next.close();
            throw error;
          }
          vault = next;
          defaultRoot = next.root;
          connectionError = '';
          return send(res, 200, await next.scan());
        } finally {
          switching = false;
        }
      }
      if (!vault) throw new VaultError('请先连接 Vault');
      const active = vault;
      if (switching || req.headers['x-atlas-vault'] !== active.sessionId)
        throw new VaultError('其他窗口已切换 Vault；此窗口停止读写，请重新连接原 Vault', 409);
      if (url.pathname === '/api/snapshot' && req.method === 'GET')
        return send(res, 200, await active.scan());
      if (url.pathname === '/api/delete-preview' && req.method === 'POST') {
        const input = z
          .object({ id: z.string().uuid() })
          .strict()
          .parse(await body(req));
        return send(res, 200, await active.deletePreview(input.id));
      }
      if (url.pathname === '/api/delete-space' && req.method === 'POST') {
        const input = z
          .object({
            id: z.string().uuid(),
            expectations: z.record(z.string().uuid(), z.string().regex(/^[a-f0-9]{64}$/)),
          })
          .strict()
          .parse(await body(req));
        return send(res, 200, await active.deleteSpace(input.id, input.expectations));
      }
      if (url.pathname === '/api/notes' && req.method === 'POST')
        return send(res, 200, await active.createMarkdown(await body(req)));
      if (url.pathname === '/api/promote' && req.method === 'POST') {
        const input = z
          .object({ id: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .parse(await body(req));
        return send(res, 200, await active.promote(input.id, input.revision));
      }
      if (url.pathname === '/api/content' && req.method === 'POST') {
        const input = z
          .discriminatedUnion('action', [
            z
              .object({
                action: z.literal('read'),
                id: z.string().uuid(),
              })
              .strict(),
            z
              .object({
                action: z.literal('save'),
                id: z.string().uuid(),
                body: z.string().max(500000),
                revision: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict(),
          ])
          .parse(await body(req));
        return send(
          res,
          200,
          input.action === 'read'
            ? await active.readContent(input.id)
            : await active.saveContent(input.id, input.body, input.revision),
        );
      }
      if (url.pathname === '/api/records' && req.method === 'POST') {
        const input = z
          .object({
            data: z.unknown(),
            options: saveOptionsSchema.optional(),
            revision: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .parse(await body(req));
        return send(res, 200, await active.save(input.data, input.revision, input.options));
      }
      if (url.pathname === '/api/backups' && req.method === 'GET')
        return send(res, 200, await active.backups());
      if (url.pathname === '/api/backup' && req.method === 'POST')
        return send(res, 200, await active.backup());
      if (url.pathname === '/api/restore' && req.method === 'POST') {
        const input = z
          .object({ id: z.string().uuid(), expectations: z.record(z.string(), z.string()) })
          .parse(await body(req));
        return send(res, 200, await active.restore(input.id, input.expectations));
      }
      if (url.pathname === '/api/open' && req.method === 'POST') {
        const input = z
          .object({ id: z.string().uuid(), native: z.boolean().default(true) })
          .parse(await body(req));
        const resolved = await active.resolveResource(input.id);
        if (resolved.location === 'url') return send(res, 200, { url: resolved.target });
        if (resolved.location === 'vault' && !input.native && resolved.target.endsWith('.md'))
          return send(res, 200, { url: resolved.obsidianUrl });
        const target = resolved.location === 'external' ? resolved.target : resolved.absolute!;
        const stat = await fs.stat(target);
        if (!stat.isDirectory() && !/\.(docx?|pdf|xlsx?|pptx?|txt|md|csv|png|jpe?g)$/i.test(target))
          throw new VaultError('只允许打开文件夹或常用文档；禁止脚本和程序');
        await nativeOpen(target);
        return send(res, 200, { opened: true });
      }
      if (url.pathname === '/api/obsidian' && req.method === 'POST') {
        const input = z.object({ id: z.string().uuid() }).parse(await body(req));
        const snapshot = await active.scan();
        const matches = snapshot.entries.filter((e) => e.data.id === input.id);
        if (matches.length > 1) throw new VaultError('重复 ID，无法唯一定位文件', 409);
        const e = matches[0];
        if (!e) throw new VaultError('记录不存在');
        return send(res, 200, {
          url: await active.obsidianUrl(e.path),
        });
      }
      return send(res, 404, { error: '接口不存在' });
    }
    if (vite) return vite.middlewares(req, res);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const dist = path.join(project, 'dist');
    const candidate = path.resolve(dist, relative || 'index.html');
    if (path.relative(dist, candidate).startsWith('..')) throw new VaultError('路径越界', 403);
    let file = candidate;
    try {
      if (!(await fs.stat(file)).isFile()) file = path.join(dist, 'index.html');
    } catch {
      file = path.join(dist, 'index.html');
    }
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
    };
    const content = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(
      res,
      error instanceof VaultError ? error.status : error instanceof z.ZodError ? 400 : 500,
      { error: message },
    );
  }
});
server.once('error', async (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `ATLAS 无法启动：${origin} 已被占用。\n` +
        '如果已有 ATLAS 在运行，可直接打开该地址。需要重启时，请在原终端按 Ctrl+C 后再启动。\n' +
        "也可使用其他端口：$env:ATLAS_PORT='4319'; npm start",
    );
  } else {
    console.error(`ATLAS 无法启动：${error.message}`);
  }
  await vite?.close();
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  restoring = restoreConnection();
  void restoring.then(() =>
    console.log(
      `ATLAS ready: ${origin}\n${vault ? 'Restored the last workspace.' : 'Choose an existing Vault in the browser.'}`,
    ),
  );
});
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  server.close();
  await restoring;
  await vault?.close();
  await vite?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
