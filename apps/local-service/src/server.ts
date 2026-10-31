import { intakeServiceFor } from './application/message-intake-service';
import { workspaceServiceFor } from './application/workspace-service';
import { businessApiVersion, businessCommandSchema } from '../../../packages/domain/business';
import { messageServiceFor } from './application/message-inbox-service';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot as project } from './project-root';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { Vault, VaultError } from './native/vault';
import { recordContract, saveOptionsSchema } from '../../../packages/domain/index';
import { readLocalConfig, rememberVault } from './local-config';

import {
  aiProviderSchema,
  messageSettingsSchema,
  sourceMessageSchema,
  suggestionSchema,
} from '../../../packages/domain/messages';
import { aiView, saveAiConfig, saveQqConfig } from './sync/app-config';
import { QqSync } from './sync/qq-sync';

let port = Number(process.env.ATLAS_PORT ?? 4317);
let origin = `http://127.0.0.1:${port}`;
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
const qqSync = new QqSync(() => vault);
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
      if (url.pathname === '/api/business/v1/schema' && req.method === 'GET')
        return send(res, 200, {
          version: businessApiVersion,
          schema: z.toJSONSchema(businessCommandSchema, { io: 'input' }),
        });
      if (url.pathname === '/api/business/v1/workspace' && req.method === 'GET')
        return send(res, 200, {
          version: businessApiVersion,
          snapshot: await workspaceServiceFor(active).snapshot(),
        });
      if (url.pathname === '/api/business/v1/commands' && req.method === 'POST')
        return send(res, 200, {
          version: businessApiVersion,
          result: await workspaceServiceFor(active).execute(await body(req)),
        });
      if (url.pathname === '/api/snapshot' && req.method === 'GET')
        return send(res, 200, await active.scan());
      if (url.pathname === '/api/messages' && req.method === 'GET') {
        const { state, revision } = await messageServiceFor(active).messageInbox();
        return send(res, 200, {
          state,
          revision,
          ai: await aiView(),
          qq: await qqSync.status(),
        });
      }
      if (url.pathname === '/api/messages/ai' && req.method === 'POST') {
        const input = z
          .object({
            provider: aiProviderSchema,
            baseUrl: z.string().trim().max(500),
            model: z.string().trim().max(200),
            jsonMode: z.boolean(),
            key: z.string().max(500).optional(),
          })
          .strict()
          .parse(await body(req));
        const saved = await saveAiConfig(input).catch((error: unknown) => {
          throw new VaultError(error instanceof Error ? error.message : 'AI 设置无效，未保存', 400);
        });
        const ai = await aiView();
        const cleared = input.key !== undefined && !saved.keySaved;
        return send(res, 200, {
          message: cleared
            ? ai.profiles[ai.provider].keyFromEnv
              ? '已清除本机保存的密钥；该提供商仍使用环境变量'
              : '已清除此提供商的密钥'
            : input.key
              ? 'AI 设置与密钥已保存到本机'
              : 'AI 设置已保存到本机',
          ai,
        });
      }
      if (url.pathname === '/api/messages/qq/config' && req.method === 'POST') {
        const input = z
          .object({
            enabled: z.boolean(),
            dataDir: z.string().trim().max(1000),
            python: z.string().trim().max(200),
            intervalSeconds: z.number().min(10).max(3600),
            backfillDays: z.number().min(1).max(365),
            selfQQ: z.string().trim().max(20),
            key: z.string().max(200).optional(),
          })
          .strict()
          .parse(await body(req));
        await saveQqConfig(input);
        qqSync.restart();
        return send(res, 200, {
          message: 'QQ 同步设置已保存',
          qq: await qqSync.status(),
        });
      }
      if (url.pathname === '/api/messages/qq/groups' && req.method === 'GET') {
        try {
          const groups = await qqSync.groups();
          const contacts = await qqSync.contacts().catch(() => []);
          return send(res, 200, { groups, contacts });
        } catch (error) {
          throw new VaultError(error instanceof Error ? error.message : '读取 QQ 列表失败', 400);
        }
      }
      if (url.pathname === '/api/messages/qq/test' && req.method === 'POST') {
        try {
          return send(res, 200, await qqSync.test());
        } catch (error) {
          throw new VaultError(error instanceof Error ? error.message : '读取 QQ 数据库失败', 400);
        }
      }
      if (url.pathname === '/api/messages/qq/sync' && req.method === 'POST') {
        if ((await qqSync.status()).running) throw new VaultError('QQ 正在同步，请稍后重试', 409);
        await qqSync.run();
        return send(res, 200, { qq: await qqSync.status() });
      }
      if (url.pathname === '/api/messages/qq/manual' && req.method === 'POST') {
        const input = z
          .object({
            ruleId: z.string().uuid(),
            from: z.number().int().positive(),
            to: z.number().int().positive(),
            includeSelf: z.boolean(),
            autoAccept: z.boolean(),
            resyncSeen: z.boolean().default(false),
            useAi: z.boolean().default(true),
          })
          .strict()
          .parse(await body(req));
        if (input.to <= input.from) throw new VaultError('结束时间必须晚于开始时间', 400);
        if (input.to - input.from > 366 * 86400)
          throw new VaultError('单次手动同步最多 366 天', 400);
        try {
          const result = await qqSync.manual(
            input.ruleId,
            input.from,
            input.to,
            input.includeSelf,
            input.autoAccept,
            input.resyncSeen,
            input.useAi,
          );
          return send(res, 200, {
            ...result,
            message:
              result.messages === 0
                ? '该时间段没有读取到可识别的文本消息'
                : !result.usedAi
                  ? `读取 ${result.messages} 条，未使用 AI，已加入待确认 ${result.added} 条`
                  : `读取 ${result.messages} 条，生成 ${result.added} 项${
                      result.autoAdded ? `，自动加入 ${result.autoAdded} 项` : ''
                    }${result.pending ? `，待确认 ${result.pending} 项` : ''}${
                      result.skippedExpired ? `，跳过已过期 ${result.skippedExpired} 项` : ''
                    }`,
          });
        } catch (error) {
          throw new VaultError(error instanceof Error ? error.message : 'QQ 手动同步失败', 400);
        }
      }
      if (url.pathname === '/api/messages/settings' && req.method === 'POST') {
        const input = z
          .object({ settings: messageSettingsSchema, revision: z.string().nullable() })
          .strict()
          .parse(await body(req));
        await messageServiceFor(active).saveSettings(input.settings, input.revision);
        return send(res, 200, { saved: true });
      }
      if (url.pathname === '/api/messages/analyze' && req.method === 'POST') {
        const input = z
          .object({ message: sourceMessageSchema, revision: z.string().nullable() })
          .strict()
          .parse(await body(req));
        return send(
          res,
          200,
          await intakeServiceFor(active).receive(input.message, input.revision),
        );
      }
      if (url.pathname === '/api/messages/dismiss' && req.method === 'POST') {
        const input = z
          .object({ id: z.string().uuid(), revision: z.string().nullable() })
          .strict()
          .parse(await body(req));
        const current = await messageServiceFor(active).messageInbox();
        current.state.candidates = current.state.candidates.filter((c) => c.id !== input.id);
        await messageServiceFor(active).saveMessageInbox(current.state, input.revision);
        return send(res, 200, { dismissed: true });
      }
      if (url.pathname === '/api/messages/accept' && req.method === 'POST') {
        const input = z
          .object({
            id: z.string().uuid(),
            revision: z.string().nullable(),
            lineId: z.union([z.string().uuid(), z.literal('')]),
            projectId: z.string().uuid().nullable().optional(),
            suggestion: suggestionSchema,
          })
          .strict()
          .parse(await body(req));
        return send(
          res,
          200,
          await messageServiceFor(active).acceptMessage(
            input.id,
            input.revision,
            input.lineId,
            input.suggestion,
            input.projectId ?? null,
          ),
        );
      }
      if (url.pathname === '/api/messages/raw' && req.method === 'POST') {
        const input = z
          .object({
            ruleId: z.string().uuid(),
            text: z.string().trim().min(1).max(12000),
          })
          .strict()
          .parse(await body(req));
        try {
          return send(
            res,
            200,
            await intakeServiceFor(active).enqueueRaw(input.ruleId, input.text),
          );
        } catch (error) {
          throw new VaultError(error instanceof Error ? error.message : '加入待确认失败', 400);
        }
      }
      if (url.pathname === '/api/messages/recognize' && req.method === 'POST') {
        const input = z
          .object({ id: z.string().uuid(), revision: z.string().nullable() })
          .strict()
          .parse(await body(req));
        try {
          return send(res, 200, await intakeServiceFor(active).recognize(input.id, input.revision));
        } catch (error) {
          throw new VaultError(error instanceof Error ? error.message : 'AI 识别失败', 400);
        }
      }
      if (url.pathname === '/api/messages/bulk' && req.method === 'POST') {
        const input = z
          .object({
            action: z.enum(['accept', 'dismiss']),
            revision: z.string().nullable(),
          })
          .strict()
          .parse(await body(req));
        return send(res, 200, await messageServiceFor(active).bulk(input.action, input.revision));
      }
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
        return send(
          res,
          200,
          await workspaceServiceFor(active).saveRecord(input.data, input.revision, input.options),
        );
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
  port = (server.address() as import('node:net').AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  restoring = restoreConnection();
  void restoring.then(() => {
    console.log(
      `ATLAS ready: ${origin}\n${vault ? 'Restored the last workspace.' : 'Choose an existing Vault in the browser.'}`,
    );
    qqSync.restart();
    process.send?.({ type: 'ready', port });
  });
});
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  qqSync.stop();
  server.close();
  await restoring;
  await vault?.close();
  await vite?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('message', (message) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown')
    void shutdown();
});
// A desktop crash must not leave a hidden service holding the workspace lock.
if (process.connected) process.on('disconnect', () => void shutdown());
