import { activeAi, normalizeAiSettings } from '../sync/app-config';
import { localDay, type Entry } from '../../../../packages/domain/index';
import { isComplete } from '../../../../packages/domain/workspace';
import {
  inboxSchema,
  suggestionSchema,
  type Inbox,
  type MessageSettings,
  type Suggestion,
} from '../../../../packages/domain/messages';
import { Vault, VaultError, hash, readText, type FileChange } from '../native/vault';
import { inboxPath, readInboxText, writeInboxText } from '../sync/message-store';
import { workspaceServiceFor } from './workspace-service';

export class MessageInboxService {
  constructor(private readonly vault: Vault) {}
  async messageInbox() {
    let source = '';
    try {
      source = await readText(await this.vault.safe(inboxPath, true));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { state: readInboxText(source), revision: source ? hash(source) : null, source };
  }
  async saveMessageInbox(input: Inbox, revision: string | null) {
    await this.vault.applyBatch(async () => {
      const current = await this.messageInbox();
      if (current.revision !== revision) throw new VaultError('消息收集已更改，请刷新后重试', 409);
      return {
        records: [],
        files: [
          {
            path: inboxPath,
            content: writeInboxText(current.source, inboxSchema.parse(input)),
            expected: revision,
          },
        ],
        result: undefined,
      };
    });
  }
  async saveSettings(settings: MessageSettings, revision: string | null) {
    const current = await this.messageInbox();
    const snapshot = await workspaceServiceFor(this.vault).snapshot();
    for (const rule of settings.rules) {
      const project = rule.projectId
        ? snapshot.entries.find((e) => e.data.id === rule.projectId && e.data.type === 'project')
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
      for (const rule of settings.rules) {
        rule.useAi = false;
        rule.autoAccept = false;
      }
    for (const rule of settings.rules) {
      const previous = current.state.settings.rules.find((item) => item.id === rule.id);
      const cursorId = (item: { kind: 'group' | 'private'; chatId: string | null }) =>
        item.chatId ? (item.kind === 'private' ? `private:${item.chatId}` : item.chatId) : null;
      const nextCursorId = cursorId(rule);
      const previousCursorId = previous ? cursorId(previous) : null;
      const resetCursor =
        Boolean(nextCursorId) &&
        (!previous ||
          previousCursorId !== nextCursorId ||
          previous.kind !== rule.kind ||
          (!previous.includeSelf && rule.includeSelf));
      if (resetCursor)
        current.state.sync = current.state.sync.filter(
          (cursor) => cursor.chatId !== nextCursorId && cursor.chatId !== previousCursorId,
        );
    }
    current.state.settings = settings;
    await this.saveMessageInbox(current.state, revision);
  }
  async bulk(action: 'accept' | 'dismiss', revision: string | null) {
    const current = await this.messageInbox();
    if (current.revision !== revision) throw new VaultError('消息收集已更改，请刷新后重试', 409);
    const candidates = [...current.state.candidates];
    if (action === 'dismiss') {
      current.state.candidates = [];
      await this.saveMessageInbox(current.state, revision);
      return {
        message: `已一键忽略 ${candidates.length} 条待确认事项`,
        dismissed: candidates.length,
        accepted: 0,
        failed: 0,
      };
    }
    let accepted = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        const fresh = await this.messageInbox();
        await this.acceptMessage(
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
    return {
      message: `已一键确认 ${accepted} 条${failed ? `，${failed} 条未能确认并保留待确认` : ''}`,
      accepted,
      failed,
      dismissed: 0,
    };
  }
  async acceptMessage(
    id: string,
    revision: string | null,
    lineId: string,
    input: Suggestion,
    projectId: string | null = null,
  ) {
    const inbox = await this.messageInbox();
    if (inbox.revision !== revision) throw new VaultError('消息收集已更改，请刷新后重试', 409);
    const candidate = inbox.state.candidates.find((item) => item.id === id);
    if (!candidate) throw new VaultError('事项已处理或不存在', 409);
    const suggestion = suggestionSchema.parse(input);
    if (!['task', 'event', 'change', 'cancel'].includes(suggestion.kind))
      throw new VaultError('事项类型已变化，请刷新后重试');
    inbox.state.candidates = inbox.state.candidates.filter((item) => item.id !== id);
    const companions: FileChange[] = [
      {
        path: inboxPath,
        content: writeInboxText(inbox.source, inbox.state),
        expected: inbox.revision,
      },
    ];
    const business = workspaceServiceFor(this.vault);
    if (suggestion.kind === 'change' || suggestion.kind === 'cancel') {
      const targetId = suggestion.targetId ?? candidate.suggestion.targetId;
      if (!targetId) throw new VaultError('未找到要修改的现有事项，请到工作空间核对');
      const snapshot = await business.snapshot();
      const matches = snapshot.entries.filter((entry) => entry.data.id === targetId);
      const entry = matches.length === 1 ? matches[0] : undefined;
      if (!entry || (entry.data.type !== 'milestone' && entry.data.type !== 'todo'))
        throw new VaultError('要修改的事项已不存在或类型不支持');
      if (isComplete(entry.data, snapshot.entries))
        throw new VaultError('要修改的事项已完成，请刷新');
      const result =
        suggestion.kind === 'cancel' || suggestion.completed
          ? await business.complete(entry.data.id, entry.revision, true, companions)
          : await business.reschedule(
              entry.data.id,
              entry.revision,
              suggestion.dueDate,
              suggestion.dueTime,
              entry.data.type === 'milestone'
                ? (suggestion.location ?? entry.data.location)
                : undefined,
              companions,
            );
      return { ids: [result.data.id] };
    }
    const quote = (value: string) =>
      value
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .split(/\r?\n/)
        .map((line) => '> ' + line)
        .join('\n');
    const label = (value: string) =>
      value
        .replace(/[\r\n]+/g, ' ')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    const source = candidate.source;
    const location = suggestion.location ? '地点：' + label(suggestion.location) + '\n\n' : '';
    const text =
      'QQ · ' +
      label(candidate.conversation) +
      ' · ' +
      label(source.sender) +
      ' · ' +
      source.sentAt +
      '\n\n' +
      location +
      quote(source.text) +
      (source.context ? '\n\n相关上下文：\n' + quote(source.context) : '');
    return business.createPlan(
      {
        kind: suggestion.kind,
        title: suggestion.title,
        dueDate: suggestion.dueDate,
        dueTime: suggestion.dueTime,
        tags: suggestion.tags,
        location: suggestion.location,
        actions: suggestion.actions,
        destination: suggestion.destination ?? null,
        lineId,
        projectId: projectId ?? candidate.projectId,
        context: source.text,
        note: { id: candidate.id, text, date: localDay() },
      },
      companions,
    );
  }
}
const services = new WeakMap<Vault, MessageInboxService>();
export function messageServiceFor(vault: Vault) {
  let service = services.get(vault);
  if (!service) {
    service = new MessageInboxService(vault);
    services.set(vault, service);
  }
  return service;
}
