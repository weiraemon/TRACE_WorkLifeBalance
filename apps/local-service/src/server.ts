import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { Vault, VaultError } from './vault';
import { recordContract, saveOptionsSchema } from '../../../packages/domain/index';
import { randomUUID } from 'node:crypto';
import {
  aiDefaults,
  aiProviderSchema,
  messageSettingsSchema,
  sourceMessageSchema,
  suggestionSchema,
  matchMessage,
  type AiSettings,
} from '../../../packages/domain/messages';
import {
  analyzeMessage,
  mergeSameTitle,
  messageFingerprint,
  type ExistingMessageItem,
} from './message-analysis';
import { activeAi, aiView, normalizeAiSettings, saveAiConfig, saveQqConfig } from './app-config';
import { QqSync } from './qq-sync';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const port = Number(process.env.ATLAS_PORT ?? 4317);
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString('hex');
let vault: Vault | undefined;
let switching = false;
const analyzingMessages = new WeakSet<Vault>();
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
    if (url.pathname === '/api/session' && req.method === 'GET')
      return send(res, 200, {
        token,
        connected: Boolean(vault),
        root: vault?.root ?? '',
        vaultId: vault?.sessionId ?? '',
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
          return send(res, 200, await vault.scan());
        }
        switching = true;
        try {
          const next = await Vault.open(input.path);
          try {
            await vault?.close();
          } catch (error) {
            await next.close();
            throw error;
          }
          vault = next;
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
      if (url.pathname === '/api/messages' && req.method === 'GET') {
        const { state, revision } = await active.messageInbox();
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
          return send(res, 200, { groups: await qqSync.groups() });
        } catch (error) {
          throw new VaultError(error instanceof Error ? error.message : '读取 QQ 群列表失败', 400);
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
        const current = await active.messageInbox();
        const snapshot = await active.scan();
        for (const rule of input.settings.rules) {
          const project = rule.projectId
            ? snapshot.entries.find(
                (e) => e.data.id === rule.projectId && e.data.type === 'project',
              )
            : undefined;
          const projectData = project?.data;
          if (
            rule.projectId &&
            (!projectData || projectData.type !== 'project' || projectData.completedAt)
          )
            throw new VaultError(`会话「${rule.name}」的限定项目已删除或结束`);
          const line = rule.lineId
            ? snapshot.entries.find((e) => e.data.id === rule.lineId && e.data.type === 'workline')
            : undefined;
          const lineData = line?.data;
          if (rule.lineId && (!lineData || lineData.type !== 'workline' || lineData.completedAt))
            throw new VaultError(`会话「${rule.name}」的默认业务线已删除或结束`);
          if (lineData?.type === 'workline') {
            const parent = snapshot.entries.find((e) => e.data.id === lineData.projectId);
            const parentData = parent?.data;
            if (!parentData || parentData.type !== 'project' || parentData.completedAt)
              throw new VaultError(`会话「${rule.name}」的默认业务线所在项目已结束`);
            if (rule.projectId && lineData.projectId !== rule.projectId)
              throw new VaultError(`会话「${rule.name}」的默认业务线不属于限定项目`);
          }
        }
        const aiConfig = await activeAi();
        let aiReady = false;
        try {
          if (aiConfig.key) {
            normalizeAiSettings({
              provider: aiConfig.config.provider,
              baseUrl: aiConfig.profile.baseUrl,
              model: aiConfig.profile.model,
              jsonMode: aiConfig.profile.jsonMode,
            });
            aiReady = true;
          }
        } catch {
          aiReady = false;
        }
        if (!aiReady)
          for (const rule of input.settings.rules) {
            rule.useAi = false;
            rule.autoAccept = false;
          }
        for (const rule of input.settings.rules) {
          const previous = current.state.settings.rules.find((item) => item.id === rule.id);
          const resetCursor =
            Boolean(rule.chatId) &&
            (!previous ||
              previous.chatId !== rule.chatId ||
              (!previous.includeSelf && rule.includeSelf));
          if (resetCursor)
            current.state.sync = current.state.sync.filter(
              (cursor) => cursor.chatId !== rule.chatId,
            );
        }
        current.state.settings = input.settings;
        await active.saveMessageInbox(current.state, input.revision);
        return send(res, 200, { saved: true });
      }
      if (url.pathname === '/api/messages/analyze' && req.method === 'POST') {
        const input = z
          .object({ message: sourceMessageSchema, revision: z.string().nullable() })
          .strict()
          .parse(await body(req));
        if (analyzingMessages.has(active))
          throw new VaultError('已有消息正在分析，请稍后再试', 409);
        analyzingMessages.add(active);
        try {
          const current = await active.messageInbox();
          if (current.revision !== input.revision)
            throw new VaultError('规则已更改，请刷新后重试', 409);
          if (!matchMessage(current.state.settings, input.message))
            return send(res, 200, { message: '未命中已启用的会话规则，没有发送给 AI 模型' });
          const fingerprint = messageFingerprint(input.message);
          const cutoff = Date.now() - 7 * 86400000;
          current.state.seen = current.state.seen.filter((s) => Date.parse(s.at) >= cutoff);
          if (
            current.state.seen.some((s) => s.fingerprint === fingerprint) ||
            current.state.candidates.some((c) => c.fingerprint === fingerprint)
          )
            return send(res, 200, { message: '这条消息已处理或已在待确认列表中' });
          if (current.state.candidates.length >= 100)
            throw new VaultError('请先处理待确认消息（最多 100 条）');
          const rule = current.state.settings.rules.find((r) => r.id === input.message.ruleId)!;
          const { config, profile, key } = await activeAi();
          const label = aiDefaults[config.provider].label;
          if (!key) throw new VaultError(`请先在“会话与识别设置”保存 ${label} API 密钥`);
          let ai: AiSettings;
          try {
            ai = normalizeAiSettings({
              provider: config.provider,
              baseUrl: profile.baseUrl,
              model: profile.model,
              jsonMode: profile.jsonMode,
            });
          } catch (error) {
            throw new VaultError(
              `${label} 设置无效：${error instanceof Error ? error.message : '请检查接口地址和模型'}`,
              400,
            );
          }
          const workspace = await active.scan();
          const catalog = workspace.entries.flatMap(({ data: p }) =>
            p.type === 'project' && !p.completedAt
              ? [
                  {
                    id: p.id,
                    title: p.title,
                    lines: workspace.entries.flatMap(({ data: l }) =>
                      l.type === 'workline' && l.projectId === p.id && !l.completedAt
                        ? [{ id: l.id, title: l.title }]
                        : [],
                    ),
                  },
                ]
              : [],
          );
          const lineTitle = (lineId: string) => {
            const entry = workspace.entries.find(({ data }) => data.id === lineId);
            return entry?.data.type === 'workline' ? entry.data.title : '';
          };
          const milestones = new Map(
            workspace.entries.flatMap(({ data }) =>
              data.type === 'milestone' ? [[data.id, data] as const] : [],
            ),
          );
          const existing = workspace.entries
            .flatMap(({ data }): ExistingMessageItem[] => {
              if (data.type === 'milestone' && !data.pool && !data.completedAt)
                return [
                  {
                    id: data.id,
                    type: 'milestone' as const,
                    title: data.title,
                    dueDate: data.dueDate,
                    dueTime: data.dueTime,
                    lineTitle: lineTitle(data.lineId),
                  },
                ];
              if (data.type === 'todo' && !data.completedAt) {
                const milestone = milestones.get(data.milestoneId);
                return [
                  {
                    id: data.id,
                    type: 'todo' as const,
                    title: data.title,
                    dueDate: data.dueDate,
                    dueTime: null,
                    lineTitle: milestone ? lineTitle(milestone.lineId) : '',
                  },
                ];
              }
              return [];
            })
            .slice(0, 120);
          const projectEntry = rule.projectId
            ? workspace.entries.find(
                (e) => e.data.id === rule.projectId && e.data.type === 'project',
              )
            : undefined;
          const projectData = projectEntry?.data;
          if (
            rule.projectId &&
            (!projectData || projectData.type !== 'project' || projectData.completedAt)
          )
            throw new VaultError('会话限定项目已删除或结束，请先修改会话设置');
          const defaultLineEntry = rule.lineId
            ? workspace.entries.find((e) => e.data.id === rule.lineId && e.data.type === 'workline')
            : undefined;
          const defaultLineData = defaultLineEntry?.data;
          if (
            rule.lineId &&
            (!defaultLineData || defaultLineData.type !== 'workline' || defaultLineData.completedAt)
          )
            throw new VaultError('会话默认业务线已删除或结束，请先修改会话设置');
          if (defaultLineData?.type === 'workline') {
            const parent = workspace.entries.find((e) => e.data.id === defaultLineData.projectId);
            const parentData = parent?.data;
            if (!parentData || parentData.type !== 'project' || parentData.completedAt)
              throw new VaultError('会话默认业务线所在项目已结束，请先修改会话设置');
            if (rule.projectId && defaultLineData.projectId !== rule.projectId)
              throw new VaultError('会话默认业务线与限定项目不一致，请先修改会话设置');
          }
          const scopedCatalog = rule.projectId
            ? catalog.filter((p) => p.id === rule.projectId)
            : catalog;
          const defaultLineTitle =
            rule.lineId && defaultLineData?.type === 'workline' ? defaultLineData.title : null;
          const defaultLine = defaultLineTitle ? { title: defaultLineTitle } : null;
          const projectScope =
            !rule.lineId && projectData?.type === 'project'
              ? { id: projectData.id, title: projectData.title }
              : null;
          const suggestions = await analyzeMessage(
            input.message,
            current.state.settings,
            key,
            fetch,
            {
              catalog: rule.lineId ? [] : scopedCatalog,
              defaultLine,
              projectScope,
              existing,
              ai,
            },
          );
          const actionable = mergeSameTitle(
            suggestions.filter((s) => s.kind !== 'ignore'),
            existing,
          );
          if (current.state.candidates.length + actionable.length > 100)
            throw new VaultError(
              '本条通知包含多个事项，待确认列表空间不足；请先处理已有事项后重试，本次未保存',
            );
          const at = new Date().toISOString();
          current.state.seen = [...current.state.seen, { fingerprint, at }].slice(-500);
          const added: { id: string; suggestion: (typeof actionable)[number] }[] = [];
          for (const suggestion of actionable) {
            const candidate = {
              id: randomUUID(),
              fingerprint,
              raw: false,
              source: input.message,
              suggestion,
              conversation: rule.name,
              projectId: rule.projectId,
              lineId: rule.lineId,
              receivedAt: at,
            };
            current.state.candidates.push(candidate);
            added.push({ id: candidate.id, suggestion });
          }
          await active.saveMessageInbox(current.state, input.revision);
          if (rule.autoAccept && added.length) {
            let fresh = await active.messageInbox();
            let revision = fresh.revision;
            let accepted = 0;
            let failed = 0;
            for (const item of added) {
              if (!['task', 'event'].includes(item.suggestion.kind)) continue;
              try {
                await active.acceptMessage(item.id, revision, rule.lineId ?? '', item.suggestion);
                accepted += 1;
                fresh = await active.messageInbox();
                revision = fresh.revision;
              } catch {
                failed += 1;
              }
            }
            return send(res, 200, {
              message: `已自动加入 ${accepted} 项计划${
                added.length - accepted ? `，${added.length - accepted} 项仍待确认` : ''
              }${failed ? `（${failed} 项自动加入失败）` : ''}`,
            });
          }
          return send(res, 200, {
            message: !actionable.length
              ? `未生成事项：${suggestions.map((s) => s.reason).join('；')}`
              : `已生成 ${actionable.length} 项待确认事项，请分别核对日期与适用对象，尚未加入日程`,
          });
        } finally {
          analyzingMessages.delete(active);
        }
      }
      if (url.pathname === '/api/messages/dismiss' && req.method === 'POST') {
        const input = z
          .object({ id: z.string().uuid(), revision: z.string().nullable() })
          .strict()
          .parse(await body(req));
        const current = await active.messageInbox();
        current.state.candidates = current.state.candidates.filter((c) => c.id !== input.id);
        await active.saveMessageInbox(current.state, input.revision);
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
          await active.acceptMessage(
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
          return send(res, 200, await qqSync.enqueueRaw(input.ruleId, input.text));
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
          return send(res, 200, await qqSync.recognize(input.id, input.revision));
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
        const current = await active.messageInbox();
        if (current.revision !== input.revision)
          throw new VaultError('消息收集已更改，请刷新后重试', 409);
        const candidates = [...current.state.candidates];
        if (input.action === 'dismiss') {
          current.state.candidates = [];
          await active.saveMessageInbox(current.state, input.revision);
          return send(res, 200, {
            message: `已一键忽略 ${candidates.length} 条待确认事项`,
            dismissed: candidates.length,
            accepted: 0,
            failed: 0,
          });
        }
        let accepted = 0;
        let failed = 0;
        for (const candidate of candidates) {
          try {
            const fresh = await active.messageInbox();
            await active.acceptMessage(
              candidate.id,
              fresh.revision,
              candidate.lineId ?? '',
              candidate.suggestion,
            );
            accepted += 1;
          } catch {
            failed += 1;
          }
        }
        return send(res, 200, {
          message: `已一键确认 ${accepted} 条${failed ? `，${failed} 条未能确认并保留待确认` : ''}`,
          accepted,
          failed,
          dismissed: 0,
        });
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
  console.log(
    `ATLAS ready: ${origin}\nChoose an existing Vault in the browser. No existing notes are migrated.`,
  );
  qqSync.restart();
});
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  qqSync.stop();
  server.close();
  await vault?.close();
  await vite?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
