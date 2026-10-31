import { randomUUID } from 'node:crypto';
import {
  matchMessage,
  sourceMessageSchema,
  type Candidate,
  type Inbox,
  type MessageCatalog,
  type MessageRule,
  type MessageSettings,
  type SourceMessage,
} from '../../../../packages/domain/messages';
import { isComplete } from '../../../../packages/domain/workspace';
import { Vault, VaultError } from '../native/vault';
import {
  analyzeMessage,
  dropNoopChanges,
  mergeSameTitle,
  messageFingerprint,
  messageKey,
  type ExistingMessageItem,
} from '../sync/message-analysis';
import { activeAi, normalizeAiSettings } from '../sync/app-config';
import { workspaceServiceFor } from './workspace-service';
import { messageServiceFor } from './message-inbox-service';
export class MessageIntakeService {
  private processing = false;
  constructor(private readonly vault: Vault) {}
  async catalog(vault: Vault): Promise<MessageCatalog> {
    const workspace = await workspaceServiceFor(vault).snapshot();
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

  async existingItems(vault: Vault): Promise<ExistingMessageItem[]> {
    const workspace = await workspaceServiceFor(vault).snapshot();
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
        if (data.type === 'milestone' && !data.pool && !isComplete(data, workspace.entries))
          return [
            {
              id: data.id,
              type: 'milestone' as const,
              title: data.title,
              dueDate: data.dueDate,
              dueTime: data.dueTime,
              location: data.location ?? null,
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
              location: null,
              lineTitle: milestone ? lineTitle(milestone.lineId) : '',
            },
          ];
        }
        return [];
      })
      .slice(0, 120);
  }

  async queueRaw(
    inbox: Inbox,
    rule: MessageRule,
    source: SourceMessage,
    settings: MessageSettings = inbox.settings,
    resyncSeen = false,
  ): Promise<Candidate | null> {
    if (!matchMessage(settings, source)) return null;
    const fingerprint = messageFingerprint(source);
    const sourceKey = messageKey(source);
    const alreadyPending = inbox.candidates.some(
      (item) =>
        item.fingerprint === fingerprint ||
        Boolean(sourceKey && messageKey(item.source) === sourceKey),
    );
    if (alreadyPending) return null;
    const alreadySeen = inbox.seen.some(
      (item) =>
        item.fingerprint === fingerprint || Boolean(sourceKey && item.messageId === sourceKey),
    );
    if (!resyncSeen && alreadySeen) return null;
    const title =
      source.text
        .replace(/^(?:\s*@\S+\s*)+/, '')
        .split(/\r?\n/)[0]
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || '待整理消息';
    const at = new Date().toISOString();
    inbox.seen = [...inbox.seen, { fingerprint, at, messageId: sourceKey ?? undefined }].slice(
      -500,
    );
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

  async analyze(
    vault: Vault,
    inbox: Inbox,
    rule: MessageRule,
    source: SourceMessage,
    settings: MessageSettings = inbox.settings,
    resyncSeen = false,
  ): Promise<Candidate[]> {
    if (!matchMessage(settings, source)) return [];
    const fingerprint = messageFingerprint(source);
    const sourceKey = messageKey(source);
    const alreadyPending = inbox.candidates.some(
      (item) =>
        item.fingerprint === fingerprint ||
        Boolean(sourceKey && messageKey(item.source) === sourceKey),
    );
    if (alreadyPending) return [];
    const alreadySeen = inbox.seen.some(
      (item) =>
        item.fingerprint === fingerprint || Boolean(sourceKey && item.messageId === sourceKey),
    );
    if (!resyncSeen && alreadySeen) return [];
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
    if (rule.lineId && projectData && !projectData.lines.some((line) => line.id === rule.lineId))
      throw new VaultError('会话默认业务线与限定项目不一致');
    const projectScope =
      !rule.lineId && projectData ? { id: projectData.id, title: projectData.title } : null;
    const existing = await this.existingItems(vault);
    const suggestions = dropNoopChanges(
      await analyzeMessage(source, settings, aiConfig.key, fetch, {
        catalog: rule.lineId ? [] : projectScope ? [projectData!] : catalog,
        defaultLine: defaultLine ? { title: defaultLine.title } : null,
        projectScope,
        existing,
        ai,
      }),
      existing,
    );
    const actionable = mergeSameTitle(
      suggestions.filter((suggestion) => suggestion.kind !== 'ignore'),
      existing,
    );
    if (inbox.candidates.length + actionable.length > 100)
      throw new VaultError('请先处理待确认消息（最多 100 条）');
    const at = new Date().toISOString();
    inbox.seen = [...inbox.seen, { fingerprint, at, messageId: sourceKey ?? undefined }].slice(
      -500,
    );
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

  async enqueueRaw(ruleId: string, text: string) {
    const vault = this.vault;
    if (!vault) throw new Error('尚未连接工作目录');
    const inbox = await messageServiceFor(vault).messageInbox();
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
    await messageServiceFor(vault).saveMessageInbox(inbox.state, inbox.revision);
    return { id: candidate.id, message: '已加入待确认' };
  }

  async recognize(candidateId: string, revision: string | null) {
    if (this.processing) throw new Error('已有消息正在处理，请稍后重试');
    const vault = this.vault;
    if (!vault) throw new Error('尚未连接工作目录');
    this.processing = true;
    try {
      const inbox = await messageServiceFor(vault).messageInbox();
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
      await messageServiceFor(vault).saveMessageInbox(inbox.state, revision);
      return {
        added: added.length,
        message: added.length
          ? `AI 已识别 ${added.length} 项，请核对后确认`
          : 'AI 未生成事项；可继续手动填写或关闭',
      };
    } finally {
      this.processing = false;
    }
  }
  async receive(input: unknown, revision: string | null) {
    if (this.processing) throw new VaultError('已有消息正在处理，请稍后重试', 409);
    this.processing = true;
    try {
      const source = sourceMessageSchema.parse(input);
      const messages = messageServiceFor(this.vault);
      const inbox = await messages.messageInbox();
      if (inbox.revision !== revision) throw new VaultError('规则已更改，请刷新后重试', 409);
      if (!matchMessage(inbox.state.settings, source))
        return { message: '未命中已启用的会话规则，没有发送给 AI 模型', added: 0 };
      const fingerprint = messageFingerprint(source);
      const key = messageKey(source);
      const cutoff = Date.now() - 7 * 86400000;
      inbox.state.seen = inbox.state.seen.filter((item) => Date.parse(item.at) >= cutoff);
      if (
        inbox.state.seen.some(
          (item) => item.fingerprint === fingerprint || Boolean(key && item.messageId === key),
        ) ||
        inbox.state.candidates.some(
          (item) =>
            item.fingerprint === fingerprint || Boolean(key && messageKey(item.source) === key),
        )
      )
        return { message: '这条消息已处理或已在待确认列表中', added: 0 };
      const rule = inbox.state.settings.rules.find((item) => item.id === source.ruleId)!;
      const added = rule.useAi
        ? await this.analyze(this.vault, inbox.state, rule, source)
        : [await this.queueRaw(inbox.state, rule, source)].filter(
            (item): item is Candidate => item !== null,
          );
      await messages.saveMessageInbox(inbox.state, inbox.revision);
      let accepted = 0,
        failed = 0;
      if (rule.useAi && rule.autoAccept) {
        for (const candidate of added) {
          if (!['task', 'event'].includes(candidate.suggestion.kind)) continue;
          try {
            const fresh = await messages.messageInbox();
            await messages.acceptMessage(
              candidate.id,
              fresh.revision,
              rule.lineId ?? '',
              candidate.suggestion,
            );
            accepted++;
          } catch {
            failed++;
          }
        }
      }
      return {
        message: accepted
          ? '已自动加入 ' +
            accepted +
            ' 项计划' +
            (added.length - accepted ? '，' + (added.length - accepted) + ' 项仍待确认' : '')
          : added.length
            ? '已生成 ' + added.length + ' 项待确认事项，请核对后确认'
            : '未生成需要安排的事项',
        added: added.length,
        accepted,
        failed,
      };
    } finally {
      this.processing = false;
    }
  }
}
const services = new WeakMap<Vault, MessageIntakeService>();
export function intakeServiceFor(vault: Vault) {
  let service = services.get(vault);
  if (!service) {
    service = new MessageIntakeService(vault);
    services.set(vault, service);
  }
  return service;
}
