import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  matchMessage,
  type Candidate,
  type Inbox,
  type MessageCatalog,
  type MessageRule,
  type MessageSettings,
  type QqStatus,
  type SourceMessage,
} from '../../../packages/domain/messages';
import { Vault } from './vault';
import {
  analyzeMessage,
  mergeSameTitle,
  messageFingerprint,
  type ExistingMessageItem,
} from './message-analysis';
import { activeAi, activeQq, normalizeAiSettings, qqCacheDir, qqView } from './app-config';
import { randomUUID } from 'node:crypto';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const helper = path.join(project, 'scripts', 'qq_sync.py');

type QqMessage = {
  id: string;
  rowid: string;
  time: number;
  sender: string;
  senderId: string;
  groupId: string;
  groupQQ: string;
  text: string;
  atAll: boolean;
  atMe: boolean;
  fromSelf: boolean;
};

function commandParts(value: string) {
  return (
    value
      .match(/"[^"]*"|\S+/g)
      ?.map((part) => part.replace(/^"|"$/g, ''))
      .filter(Boolean) ?? ['py']
  );
}

function shanghaiNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
  };
}

function expiredSuggestion(suggestion: {
  kind: string;
  dueDate: string | null;
  dueTime: string | null;
}) {
  if (!['task', 'event'].includes(suggestion.kind) || !suggestion.dueDate) return false;
  const now = shanghaiNow();
  if (suggestion.dueDate < now.date) return true;
  if (suggestion.dueDate > now.date) return false;
  return Boolean(suggestion.dueTime && suggestion.dueTime < now.time);
}

export class QqSync {
  private timer?: NodeJS.Timeout;
  private running = false;
  private manualRunning = false;
  lastSyncAt: string | null = null;
  lastError = '';

  constructor(private readonly vault: () => Vault | undefined) {}

  private async call(args: string[], key: string) {
    const [command, ...prefix] = commandParts((await activeQq()).python);
    const cacheDir = qqCacheDir();
    return new Promise<any>((resolve, reject) => {
      const child = spawn(command, [...prefix, helper, ...args, '--cache-dir', cacheDir], {
        cwd: project,
        windowsHide: true,
        env: { ...process.env, QQ_DB_KEY: key },
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('QQ 读取超时'));
      }, 120_000);
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`无法启动 QQ 读取脚本：${error.message}`));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          try {
            const value = JSON.parse(stdout.trim());
            if (value?.error) {
              reject(new Error(String(value.error)));
              return;
            }
          } catch {
            /* fall through to stderr */
          }
          reject(new Error(stderr.trim().split(/\r?\n/).at(-1) || `QQ 读取失败（${code}）`));
          return;
        }
        try {
          const value = JSON.parse(stdout.trim());
          if (value?.error) reject(new Error(String(value.error)));
          else resolve(value);
        } catch {
          reject(new Error('QQ 读取脚本返回了无法解析的结果'));
        }
      });
    });
  }

  async status(): Promise<QqStatus> {
    return {
      ...(await qqView()),
      running: this.running || this.manualRunning,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    };
  }

  async groups() {
    const config = await activeQq();
    if (!config.dataDir) throw new Error('请先填写 QQ 数据目录');
    if (!config.key) throw new Error('请先保存 QQ 数据库密钥');
    const result = await this.call(['groups', '--db-dir', config.dataDir], config.key);
    return result.groups as { id: string; name: string }[];
  }

  async test() {
    const config = await activeQq();
    if (!config.dataDir) throw new Error('请先填写 QQ 数据目录');
    if (!config.key) throw new Error('请先保存 QQ 数据库密钥');
    return this.call(['test', '--db-dir', config.dataDir], config.key);
  }

  restart() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const run = () =>
      void this.run().catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    void activeQq()
      .then((config) => {
        if (!config.enabled || !config.key || !config.dataDir) return;
        this.timer = setInterval(run, Math.max(10, config.intervalSeconds) * 1000);
        this.timer.unref();
        run();
      })
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async catalog(vault: Vault): Promise<MessageCatalog> {
    const workspace = await vault.scan();
    return workspace.entries.flatMap(({ data: p }) =>
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
  }

  private async existingItems(vault: Vault): Promise<ExistingMessageItem[]> {
    const workspace = await vault.scan();
    const lineTitle = (lineId: string) => {
      const entry = workspace.entries.find(({ data }) => data.id === lineId);
      return entry?.data.type === 'workline' ? entry.data.title : '';
    };
    const milestones = new Map(
      workspace.entries.flatMap(({ data }) =>
        data.type === 'milestone' ? [[data.id, data] as const] : [],
      ),
    );
    return workspace.entries
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
  }

  private async queueRaw(
    inbox: Inbox,
    rule: MessageRule,
    source: SourceMessage,
    settings: MessageSettings = inbox.settings,
    resyncSeen = false,
  ): Promise<Candidate | null> {
    if (!matchMessage(settings, source)) return null;
    const fingerprint = messageFingerprint(source);
    if (inbox.candidates.some((item) => item.fingerprint === fingerprint)) return null;
    if (!resyncSeen && inbox.seen.some((item) => item.fingerprint === fingerprint)) return null;
    const title =
      source.text
        .replace(/^(?:\s*@\S+\s*)+/, '')
        .split(/\r?\n/)[0]
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || '待整理消息';
    const at = new Date().toISOString();
    inbox.seen = [...inbox.seen, { fingerprint, at }].slice(-500);
    const candidate: Candidate = {
      id: randomUUID(),
      fingerprint,
      raw: true,
      source,
      conversation: rule.name,
      projectId: rule.projectId,
      lineId: rule.lineId,
      receivedAt: at,
      suggestion: {
        kind: 'task',
        targetId: null,
        completed: false,
        title,
        dueDate: null,
        dueTime: null,
        reason: '未使用 AI，等待手动设置',
        uncertainty: '请设置日期、项目和业务线后确认，或点击“用 AI 识别”。',
        actions: [],
        tags: [],
        location: null,
        destination: null,
      },
    };
    inbox.candidates.push(candidate);
    return candidate;
  }

  private async analyze(
    vault: Vault,
    inbox: Inbox,
    rule: MessageRule,
    source: SourceMessage,
    settings: MessageSettings = inbox.settings,
    resyncSeen = false,
  ): Promise<Candidate[]> {
    if (!matchMessage(settings, source)) return [];
    const fingerprint = messageFingerprint(source);
    if (inbox.candidates.some((item) => item.fingerprint === fingerprint)) return [];
    if (!resyncSeen && inbox.seen.some((item) => item.fingerprint === fingerprint)) return [];
    if (inbox.candidates.length >= 100) throw new Error('待确认消息已满 100 条');
    const aiConfig = await activeAi();
    const ai = normalizeAiSettings({
      provider: aiConfig.config.provider,
      baseUrl: aiConfig.profile.baseUrl,
      model: aiConfig.profile.model,
      jsonMode: aiConfig.profile.jsonMode,
    });
    if (!aiConfig.key) throw new Error('尚未配置 AI 密钥');
    const catalog = await this.catalog(vault);
    const projectData = rule.projectId
      ? catalog.find((item) => item.id === rule.projectId)
      : undefined;
    if (rule.projectId && !projectData) throw new Error('会话限定项目已删除或结束');
    const defaultLine = rule.lineId
      ? catalog.flatMap((item) => item.lines).find((line) => line.id === rule.lineId)
      : undefined;
    if (rule.lineId && !defaultLine) throw new Error('会话默认业务线已删除或结束');
    const projectScope =
      !rule.lineId && projectData ? { id: projectData.id, title: projectData.title } : null;
    const existing = await this.existingItems(vault);
    const suggestions = await analyzeMessage(source, settings, aiConfig.key, fetch, {
      catalog: rule.lineId ? [] : projectScope ? [projectData!] : catalog,
      defaultLine: defaultLine ? { title: defaultLine.title } : null,
      projectScope,
      existing,
      ai,
    });
    const actionable = mergeSameTitle(
      suggestions.filter((suggestion) => suggestion.kind !== 'ignore'),
      existing,
    );
    if (!actionable.length) return [];
    const at = new Date().toISOString();
    inbox.seen = [...inbox.seen, { fingerprint, at }].slice(-500);
    const added: Candidate[] = [];
    for (const suggestion of actionable) {
      const candidate: Candidate = {
        id: randomUUID(),
        fingerprint,
        raw: false,
        source,
        suggestion,
        conversation: rule.name,
        projectId: rule.projectId,
        lineId: rule.lineId,
        receivedAt: at,
      };
      inbox.candidates.push(candidate);
      added.push(candidate);
    }
    return added;
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
    if (this.running || this.manualRunning) throw new Error('QQ 正在同步，请稍后重试');
    this.manualRunning = true;
    try {
      return await this.manualInner(ruleId, from, to, includeSelf, autoAccept, resyncSeen, useAi);
    } finally {
      this.manualRunning = false;
    }
  }

  private async manualInner(
    ruleId: string,
    from: number,
    to: number,
    includeSelf: boolean,
    autoAccept: boolean,
    resyncSeen: boolean,
    useAi: boolean,
  ) {
    const vault = this.vault();
    if (!vault) throw new Error('尚未连接工作目录');
    const config = await activeQq();
    if (!config.dataDir || !config.key) throw new Error('请先完成 QQ 同步设置');
    let inbox = await vault.messageInbox();
    let revision = inbox.revision;
    const sourceRule = inbox.state.settings.rules.find((rule) => rule.id === ruleId);
    if (!sourceRule) throw new Error('会话规则不存在');
    if (!sourceRule.chatId) throw new Error('该规则尚未绑定 QQ 群或 QQ 号');
    const rule = { ...sourceRule, includeSelf, enabled: true };
    const settings = {
      ...inbox.state.settings,
      rules: inbox.state.settings.rules.map((item) => (item.id === ruleId ? rule : item)),
    };
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
    const effectiveUseAi = useAi && aiReady;
    const args = [
      'messages',
      '--db-dir',
      config.dataDir,
      '--since-time',
      String(from),
      '--until-time',
      String(to),
      '--self-qq',
      config.selfQQ,
      '--limit',
      '50',
      ...(includeSelf ? ['--include-self'] : []),
      ...(rule.kind === 'private' ? ['--private', rule.chatId!] : ['--group', rule.chatId!]),
    ];
    const result = await this.call(args, config.key);
    const messages = (result.messages ?? []) as QqMessage[];
    const added: Candidate[] = [];
    let skippedExpired = 0;
    for (const message of messages) {
      const source: SourceMessage = {
        ruleId: rule.id,
        sender: message.sender || message.senderId || 'QQ',
        sentAt: new Date(message.time * 1000).toISOString(),
        text: message.text,
        context: '',
        atAll: Boolean(message.atAll),
        atMe: Boolean(message.atMe),
        remoteId: message.id,
        fromSelf: Boolean(message.fromSelf),
      };
      if (!effectiveUseAi) {
        const raw = await this.queueRaw(inbox.state, rule, source, settings, resyncSeen);
        if (raw) added.push(raw);
        continue;
      }
      const created = await this.analyze(vault, inbox.state, rule, source, settings, resyncSeen);
      const kept = created.filter((candidate) => !expiredSuggestion(candidate.suggestion));
      if (kept.length !== created.length) {
        const createdIds = new Set(created.map((candidate) => candidate.id));
        const keptIds = new Set(kept.map((candidate) => candidate.id));
        inbox.state.candidates = inbox.state.candidates.filter(
          (candidate) => !createdIds.has(candidate.id) || keptIds.has(candidate.id),
        );
        skippedExpired += created.length - kept.length;
      }
      added.push(...kept);
    }
    if (messages.length) {
      await vault.saveMessageInbox(inbox.state, revision);
      const refreshed = await vault.messageInbox();
      inbox = refreshed;
      revision = refreshed.revision;
    }
    let autoAdded = 0;
    let failed = 0;
    if (autoAccept && effectiveUseAi) {
      for (const candidate of added) {
        if (!['task', 'event'].includes(candidate.suggestion.kind)) continue;
        try {
          await vault.acceptMessage(
            candidate.id,
            revision,
            candidate.lineId ?? '',
            candidate.suggestion,
          );
          autoAdded += 1;
          const refreshed = await vault.messageInbox();
          inbox = refreshed;
          revision = refreshed.revision;
        } catch {
          failed += 1;
        }
      }
    }
    return {
      messages: messages.length,
      added: added.length,
      autoAdded,
      pending: added.length - autoAdded,
      skippedExpired,
      usedAi: effectiveUseAi,
      failed,
    };
  }

  async enqueueRaw(ruleId: string, text: string) {
    const vault = this.vault();
    if (!vault) throw new Error('尚未连接工作目录');
    const inbox = await vault.messageInbox();
    const sourceRule = inbox.state.settings.rules.find((rule) => rule.id === ruleId);
    if (!sourceRule) throw new Error('会话规则不存在');
    const rule = { ...sourceRule, enabled: true, mode: 'all' as const };
    const settings = {
      ...inbox.state.settings,
      rules: inbox.state.settings.rules.map((item) => (item.id === rule.id ? rule : item)),
    };
    const source: SourceMessage = {
      ruleId: rule.id,
      sender: '手动',
      sentAt: new Date().toISOString(),
      text,
      context: '',
      atAll: false,
      atMe: false,
      remoteId: null,
      fromSelf: false,
    };
    const candidate = await this.queueRaw(inbox.state, rule, source, settings, true);
    if (!candidate) throw new Error('这条文字已在待确认或已处理');
    await vault.saveMessageInbox(inbox.state, inbox.revision);
    return { id: candidate.id, message: '已加入待确认' };
  }

  async recognize(candidateId: string, revision: string | null) {
    if (this.running || this.manualRunning) throw new Error('QQ 正在同步，请稍后重试');
    const vault = this.vault();
    if (!vault) throw new Error('尚未连接工作目录');
    this.manualRunning = true;
    try {
      const inbox = await vault.messageInbox();
      if (revision !== inbox.revision) throw new Error('消息收集已更改，请刷新后重试');
      const candidate = inbox.state.candidates.find((item) => item.id === candidateId);
      if (!candidate) throw new Error('事项已处理或不存在');
      if (!candidate.raw) throw new Error('这条消息已经使用 AI 识别');
      const sourceRule = inbox.state.settings.rules.find(
        (rule) => rule.id === candidate.source.ruleId,
      );
      if (!sourceRule) throw new Error('会话规则不存在');
      const rule = { ...sourceRule, enabled: true };
      const settings = {
        ...inbox.state.settings,
        rules: inbox.state.settings.rules.map((item) => (item.id === rule.id ? rule : item)),
      };
      inbox.state.candidates = inbox.state.candidates.filter((item) => item.id !== candidateId);
      const added = await this.analyze(vault, inbox.state, rule, candidate.source, settings, true);
      await vault.saveMessageInbox(inbox.state, revision);
      return {
        added: added.length,
        message: added.length
          ? `AI 已识别 ${added.length} 项，请核对后确认`
          : 'AI 未生成事项；可继续手动填写或关闭',
      };
    } finally {
      this.manualRunning = false;
    }
  }

  async run() {
    if (this.running || this.manualRunning) return;
    const vault = this.vault();
    if (!vault) return;
    const config = await activeQq();
    if (!config.enabled || !config.dataDir || !config.key) return;
    this.running = true;
    this.lastError = '';
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
    if (!aiReady) this.lastError = 'AI 密钥未配置，消息按未使用 AI 加入待确认';
    try {
      let inbox = await vault.messageInbox();
      let revision = inbox.revision;
      const rules = inbox.state.settings.rules.filter(
        (rule) => rule.enabled && rule.kind === 'group' && rule.chatId,
      );
      for (const rule of rules) {
        const cursor = inbox.state.sync.find((item) => item.chatId === rule.chatId);
        let result;
        try {
          result = await this.call(
            [
              'messages',
              '--db-dir',
              config.dataDir,
              '--group',
              rule.chatId!,
              '--after-rowid',
              cursor?.afterRowid || '0',
              '--after-time',
              String(cursor?.afterTime ?? 0),
              '--after-id',
              cursor?.afterId || '0',
              '--self-qq',
              config.selfQQ,
              ...(rule.includeSelf ? ['--include-self'] : []),
              '--since-days',
              String(config.backfillDays),
              '--limit',
              '20',
            ],
            config.key,
          );
        } catch (error) {
          this.lastError = `${rule.name}：${error instanceof Error ? error.message : String(error)}`;
          continue;
        }
        const messages = (result.messages ?? []) as QqMessage[];
        let failed = false;
        for (const message of messages) {
          const source: SourceMessage = {
            ruleId: rule.id,
            sender: message.sender || message.senderId || 'QQ',
            sentAt: new Date(message.time * 1000).toISOString(),
            text: message.text,
            context: '',
            atAll: Boolean(message.atAll),
            atMe: Boolean(message.atMe),
            remoteId: message.id,
            fromSelf: Boolean(message.fromSelf),
          };
          try {
            if (!rule.useAi || !aiReady) {
              await this.queueRaw(inbox.state, rule, source);
            } else {
              const added = await this.analyze(vault, inbox.state, rule, source);
              if (rule.autoAccept && added.length) {
                try {
                  await vault.saveMessageInbox(inbox.state, revision);
                  let refreshed = await vault.messageInbox();
                  inbox = refreshed;
                  revision = refreshed.revision;
                  for (const candidate of added) {
                    if (!['task', 'event'].includes(candidate.suggestion.kind)) continue;
                    await vault.acceptMessage(
                      candidate.id,
                      revision,
                      candidate.lineId ?? '',
                      candidate.suggestion,
                    );
                    refreshed = await vault.messageInbox();
                    inbox = refreshed;
                    revision = refreshed.revision;
                  }
                } catch (error) {
                  this.lastError = `${rule.name}：自动加入失败，已保留待确认：${
                    error instanceof Error ? error.message : String(error)
                  }`;
                  failed = true;
                  break;
                }
              }
            }
          } catch (error) {
            this.lastError = `${rule.name}：${error instanceof Error ? error.message : String(error)}`;
            failed = true;
            break;
          }
        }
        if (!failed && result.next) {
          const next = result.next as { afterRowid?: string; afterTime?: number; afterId?: string };
          const sync = {
            chatId: rule.chatId!,
            afterRowid: next.afterRowid ?? cursor?.afterRowid ?? '0',
            afterTime: next.afterTime ?? cursor?.afterTime ?? 0,
            afterId: next.afterId ?? cursor?.afterId ?? '0',
          };
          const index = inbox.state.sync.findIndex((item) => item.chatId === rule.chatId);
          if (index >= 0) inbox.state.sync[index] = sync;
          else inbox.state.sync.push(sync);
        }
        try {
          await vault.saveMessageInbox(inbox.state, revision);
          const refreshed = await vault.messageInbox();
          inbox = refreshed;
          revision = refreshed.revision;
        } catch (error) {
          this.lastError = `保存同步结果失败：${error instanceof Error ? error.message : String(error)}`;
          break;
        }
      }
      this.lastSyncAt = new Date().toISOString();
    } finally {
      this.running = false;
    }
  }
}
