import { spawn } from 'node:child_process';
import path from 'node:path';
import { projectRoot } from '../project-root';
import type { SourceMessage, WeChatStatus } from '../../../../packages/domain/messages';
import type { Vault } from '../native/vault';
import { messageServiceFor } from '../application/message-inbox-service';
import { intakeServiceFor } from '../application/message-intake-service';
import { activeAi, activeWeChat, normalizeAiSettings, wechatView } from './app-config';

const helper = path.join(projectRoot, 'scripts', 'wechat_sync.py');
type WeChatMessage = {
  id: string;
  time: number;
  sender: string;
  senderId: string;
  text: string;
  atAll: boolean;
  atMe: boolean;
  fromSelf: boolean;
};

function commandParts(value: string) {
  return value.match(/"[^"]*"|\S+/g)?.map((part) => part.replace(/^"|"$/g, '')) ?? ['py', '-3.12'];
}

export class WeChatSync {
  private timer?: NodeJS.Timeout;
  private running = false;
  lastSyncAt: string | null = null;
  lastError = '';
  constructor(private readonly vault: () => Vault | undefined) {}

  private async call(args: string[]): Promise<any> {
    const config = await activeWeChat();
    const [command, ...prefix] = process.env.CHAOS_BUNDLED_PYTHON
      ? [process.env.CHAOS_BUNDLED_PYTHON]
      : commandParts(config.python);
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...prefix, helper, ...args], {
        cwd: projectRoot,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('微信读取超时'));
      }, 120_000);
      child.stdout.on('data', (data) => {
        stdout += String(data);
        if (stdout.length > 4_000_000) {
          child.kill();
          reject(new Error('微信读取结果过大'));
        }
      });
      child.stderr.on('data', (data) => {
        stderr += String(data).slice(0, 2000);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        try {
          const value = JSON.parse(stdout.trim());
          if (code !== 0 || value.error)
            reject(new Error(String(value.error || stderr || '微信读取失败')));
          else resolve(value);
        } catch {
          reject(new Error(stderr.trim().split(/\r?\n/).at(-1) || '微信读取脚本返回了无效结果'));
        }
      });
    });
  }

  async status(): Promise<WeChatStatus> {
    return {
      ...(await wechatView()),
      running: this.running,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    };
  }
  async test() {
    return this.call(['status']);
  }
  async chats() {
    return this.call(['chats']);
  }

  async manual(
    ruleId: string,
    from: number,
    to: number,
    includeSelf: boolean,
    autoAccept: boolean,
    resyncSeen: boolean,
    useAi: boolean,
  ) {
    if (this.running) throw new Error('微信正在同步，请稍后重试');
    const vault = this.vault();
    if (!vault) throw new Error('尚未连接工作目录');
    if (!(await wechatView()).keySaved) throw new Error('尚未初始化微信数据库密钥');
    const initial = await messageServiceFor(vault).messageInbox();
    const rule = initial.state.settings.rules.find(
      (item) => item.id === ruleId && item.provider === 'wechat',
    );
    if (!rule?.chatId) throw new Error('微信会话规则不存在或未绑定会话');

    this.running = true;
    this.lastError = '';
    try {
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
        /* queue raw when AI is unavailable */
      }

      const result = await this.call([
        'messages',
        '--chat-id',
        rule.chatId,
        '--after-json',
        '{}',
        '--since-time',
        String(from),
        '--until-time',
        String(to),
        '--limit',
        '100',
      ]);
      if (result.inactive) throw new Error('已退出或找不到此微信会话');
      const rows = (result.messages ?? []) as WeChatMessage[];
      let inbox = initial;
      let revision = inbox.revision;
      let added = 0;
      let autoAdded = 0;
      for (const row of rows) {
        if (row.fromSelf && !includeSelf) continue;
        const source: SourceMessage = {
          provider: 'wechat',
          ruleId: rule.id,
          sender: row.sender || row.senderId || '微信',
          sentAt: new Date(row.time * 1000).toISOString(),
          text: row.text,
          context: '',
          atAll: row.atAll,
          atMe: row.atMe,
          remoteId: row.id,
          fromSelf: row.fromSelf,
        };
        if (!useAi || !aiReady) {
          const candidate = await intakeServiceFor(vault).queueRaw(
            inbox.state,
            rule,
            source,
            inbox.state.settings,
            resyncSeen,
          );
          if (candidate) added++;
          continue;
        }
        const created = await intakeServiceFor(vault).analyze(
          vault,
          inbox.state,
          rule,
          source,
          inbox.state.settings,
          resyncSeen,
        );
        added += created.length;
        if (!autoAccept || !created.length) continue;
        await messageServiceFor(vault).saveMessageInbox(inbox.state, revision);
        inbox = await messageServiceFor(vault).messageInbox();
        revision = inbox.revision;
        for (const candidate of created) {
          if (!['task', 'event'].includes(candidate.suggestion.kind)) continue;
          await messageServiceFor(vault).acceptMessage(
            candidate.id,
            revision,
            candidate.lineId ?? '',
            candidate.suggestion,
          );
          autoAdded++;
          inbox = await messageServiceFor(vault).messageInbox();
          revision = inbox.revision;
        }
        inbox = await messageServiceFor(vault).messageInbox();
        revision = inbox.revision;
      }
      await messageServiceFor(vault).saveMessageInbox(inbox.state, revision);
      this.lastSyncAt = new Date().toISOString();
      return { messages: rows.length, added, autoAdded, pending: added - autoAdded };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.running = false;
    }
  }

  restart() {
    this.stop();
    void activeWeChat().then((config) => {
      if (!config.enabled) return;
      const run = () =>
        void this.run().catch((error: unknown) => {
          this.lastError = error instanceof Error ? error.message : String(error);
        });
      this.timer = setInterval(run, config.intervalSeconds * 1000);
      this.timer.unref();
      run();
    });
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async run() {
    if (this.running) return;
    const vault = this.vault();
    if (!vault) return;
    const config = await activeWeChat();
    if (!config.enabled || !(await wechatView()).keySaved) return;
    this.running = true;
    this.lastError = '';
    try {
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
        /* queue raw when AI is unavailable */
      }
      let inbox = await messageServiceFor(vault).messageInbox();
      let revision = inbox.revision;
      const rules = inbox.state.settings.rules.filter(
        (rule) => rule.provider === 'wechat' && rule.enabled && rule.chatId,
      );
      for (const rule of rules) {
        const prefix = `wechat:${rule.chatId}:`;
        const after: Record<string, number> = {};
        for (const cursor of inbox.state.sync) {
          if (cursor.chatId.startsWith(prefix))
            after[cursor.chatId.slice(prefix.length)] = Number(cursor.afterRowid) || 0;
        }
        try {
          const result = await this.call([
            'messages',
            '--chat-id',
            rule.chatId!,
            '--after-json',
            JSON.stringify(after),
            '--since-time',
            String(Math.floor(Date.now() / 1000) - config.backfillDays * 86400),
            '--limit',
            '20',
          ]);
          if (result.inactive) {
            this.lastError = `${rule.name}：已退出或找不到此微信群，规则已暂停读取`;
            continue;
          }
          const rows = (result.messages ?? []) as WeChatMessage[];
          let failed = false;
          for (const row of rows) {
            if (row.fromSelf && !rule.includeSelf) continue;
            const source: SourceMessage = {
              provider: 'wechat',
              ruleId: rule.id,
              sender: row.sender || row.senderId || '微信',
              sentAt: new Date(row.time * 1000).toISOString(),
              text: row.text,
              context: '',
              atAll: row.atAll,
              atMe: row.atMe,
              remoteId: row.id,
              fromSelf: row.fromSelf,
            };
            try {
              if (!rule.useAi || !aiReady) {
                await intakeServiceFor(vault).queueRaw(inbox.state, rule, source);
              } else {
                const added = await intakeServiceFor(vault).analyze(
                  vault,
                  inbox.state,
                  rule,
                  source,
                );
                if (rule.autoAccept && added.length) {
                  await messageServiceFor(vault).saveMessageInbox(inbox.state, revision);
                  inbox = await messageServiceFor(vault).messageInbox();
                  revision = inbox.revision;
                  for (const candidate of added) {
                    if (!['task', 'event'].includes(candidate.suggestion.kind)) continue;
                    await messageServiceFor(vault).acceptMessage(
                      candidate.id,
                      revision,
                      candidate.lineId ?? '',
                      candidate.suggestion,
                    );
                    inbox = await messageServiceFor(vault).messageInbox();
                    revision = inbox.revision;
                  }
                }
              }
            } catch (error) {
              this.lastError = `${rule.name}：${error instanceof Error ? error.message : String(error)}`;
              failed = true;
              break;
            }
          }
          if (!failed) {
            for (const [shard, localId] of Object.entries(result.next ?? {}) as [
              string,
              number,
            ][]) {
              const chatId = prefix + shard;
              const cursor = { chatId, afterRowid: String(localId), afterTime: 0, afterId: '0' };
              const index = inbox.state.sync.findIndex((entry) => entry.chatId === chatId);
              if (index >= 0) inbox.state.sync[index] = cursor;
              else inbox.state.sync.push(cursor);
            }
          }
          await messageServiceFor(vault).saveMessageInbox(inbox.state, revision);
          inbox = await messageServiceFor(vault).messageInbox();
          revision = inbox.revision;
          if (failed) break;
        } catch (error) {
          this.lastError = `${rule.name}：${error instanceof Error ? error.message : String(error)}`;
          break;
        }
      }
      this.lastSyncAt = new Date().toISOString();
    } finally {
      this.running = false;
    }
  }
}
