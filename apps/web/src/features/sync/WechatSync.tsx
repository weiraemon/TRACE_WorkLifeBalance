import { useEffect, useState } from 'react';
import type { Snapshot } from '../../../../../packages/domain/index';
import { isComplete } from '../../../../../packages/domain/workspace';
import {
  conditionLabels,
  type InboxView,
  type MessageRule,
  type MessageSettings,
  type Suggestion,
} from '../../../../../packages/domain/messages';
import { api } from '../../api';
import { desktopBridge } from '../../platform/desktop';
import { Button, ErrorMessage, Field } from '../../components/ui';
import { CandidateCard } from './MessageInbox';

type Chat = { id: string; name: string; remark?: string; alias?: string;
  members?: string[]; memberCount?: number };

export function WechatSync({ snapshot, reload, onPendingChange, mode = 'settings' }: {
  snapshot: Snapshot;
  reload: () => Promise<void>;
  onPendingChange?: (count: number) => void;
  mode?: 'pending' | 'settings';
}) {
  const [view, setView] = useState<InboxView | null>(null);
  const [settings, setSettings] = useState<MessageSettings>({ names: [], classes: [], rules: [] });
  const [config, setConfig] = useState({ enabled: false, python: 'py -3.12', intervalSeconds: 30, backfillDays: 7 });
  const [tab, setTab] = useState<'global' | 'rules'>('global');
  const [kind, setKind] = useState<'group' | 'private'>('group');
  const [groups, setGroups] = useState<Chat[]>([]);
  const [contacts, setContacts] = useState<Chat[]>([]);
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [bulk, setBulk] = useState<'accept' | 'dismiss' | null>(null);

  const refresh = async () => {
    const next = await api<InboxView>('messages');
    setView(next);
    setSettings(next.state.settings);
    onPendingChange?.(next.state.candidates.length);
    if (next.wechat) setConfig({ enabled: next.wechat.enabled, python: next.wechat.python,
      intervalSeconds: next.wechat.intervalSeconds, backfillDays: next.wechat.backfillDays });
  };
  useEffect(() => { void refresh().catch((cause) => setError(String(cause))); }, [snapshot.vaultId]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const updateRule = (id: string, value: Partial<MessageRule>) =>
    setSettings((current) => ({ ...current,
      rules: current.rules.map((rule) => rule.id === id ? { ...rule, ...value } : rule) }));
  const saveRules = () => void run(async () => {
    await api('messages/settings', { settings, revision: view?.revision ?? null });
    setNotice('微信会话规则已保存');
  });
  const addRule = () => setSettings((current) => ({ ...current, rules: [{
    id: crypto.randomUUID(), provider: 'wechat', name: '', kind,
    enabled: kind === 'group', useAi: true, autoAccept: false, includeSelf: false,
    mode: 'all', conditions: [], senders: [], keywords: [], aliases: [],
    chatId: null, projectId: null, lineId: null,
  }, ...current.rules] }));
  const loadChats = () => void run(async () => {
    const result = await api<{ groups: Chat[]; contacts: Chat[] }>('messages/wechat/chats');
    setGroups(result.groups); setContacts(result.contacts);
    setNotice(`已读取 ${result.groups.length} 个微信群和 ${result.contacts.length} 个联系人`);
  });

  if (!view) return <section className="message-inbox"><p>正在读取微信同步…</p><ErrorMessage message={error} /></section>;
  const candidates = view.state.candidates.filter((item) => item.source.provider === 'wechat');
  const rules = settings.rules.filter((rule) => rule.provider === 'wechat' && rule.kind === kind);
  const aiReady = view.ai.profiles[view.ai.provider].ready;
  const setupWechat = desktopBridge()?.setupWechat;
  const projects = snapshot.entries.filter((entry) => entry.data.type === 'project' &&
    !isComplete(entry.data, snapshot.entries));
  const lines = snapshot.entries.filter((entry) => entry.data.type === 'workline' &&
    !isComplete(entry.data, snapshot.entries));
  return (
    <section className={`message-inbox mode-${mode}`} aria-label="微信同步消息">
      {mode === 'settings' && <>
        <p className="message-notice">只读取本人微信的本机数据库。启用后，定时检查已绑定的群聊或联系人。</p>
        <div className="segmented">
          <button aria-pressed={tab === 'global'} onClick={() => setTab('global')}>微信同步设置</button>
          <button aria-pressed={tab === 'rules'} onClick={() => setTab('rules')}>会话规则</button>
        </div>
      </>}
      <ErrorMessage message={error} />
      {notice && <p role="status">{notice}</p>}
      {mode === 'settings' && tab === 'global' && <>
        <h3>微信数据库读取</h3>
        <p className="hint">{setupWechat
          ? '首次使用请选择本人微信数据目录，并按弹出窗口提示验证密钥。'
          : '首次使用请运行发布包中的 setup-wechat.cmd，按提示选择本人账号。'}密钥只保存在本机用户配置目录。</p>
        {setupWechat && <Button disabled={busy} onClick={() => void run(async () => {
          const finished = await setupWechat();
          if (finished) setNotice('微信密钥初始化成功，请测试读取');
        })}>选择微信数据目录并初始化…</Button>}
        <p>{view.wechat?.keySaved ? '数据库密钥已保存' : '尚未初始化数据库密钥'}</p>
        {view.wechat?.lastError && <p className="message-notice">最近同步：{view.wechat.lastError}</p>}
        {view.wechat?.lastSyncAt && <p className="hint">上次检查：{new Date(view.wechat.lastSyncAt).toLocaleString()}</p>}
        <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
          await api('messages/wechat/config', config);
          setNotice('微信同步设置已保存');
        }); }}>
          <label><input type="checkbox" checked={config.enabled} onChange={(event) =>
            setConfig({ ...config, enabled: event.target.checked })} /> 启用微信自动同步</label>
          <Field label="同步间隔（秒）"><input type="number" min={10} max={3600}
            value={config.intervalSeconds} onChange={(event) => setConfig({ ...config,
              intervalSeconds: Number(event.target.value) })} /></Field>
          <Field label="首次回填天数"><input type="number" min={1} max={365}
            value={config.backfillDays} onChange={(event) => setConfig({ ...config,
              backfillDays: Number(event.target.value) })} /></Field>
          {!setupWechat && <Field label="Python 命令"><input value={config.python} onChange={(event) =>
            setConfig({ ...config, python: event.target.value })} /></Field>}
          <Button disabled={busy}>保存微信设置</Button>
        </form>
        <div className="message-bulk-actions">
          <Button disabled={busy || !view.wechat?.keySaved} onClick={() => void run(async () => {
            const result = await api<{ groups: number; contacts: number; shards: number }>('messages/wechat/test', {});
            setNotice(`数据库可读：${result.shards} 个消息分库、${result.groups} 个群、${result.contacts} 个联系人`);
          })}>测试读取</Button>
          <Button disabled={busy || !view.wechat?.configured || !config.enabled}
            onClick={() => void run(async () => {
              const result = await api<{ wechat: { lastError: string } }>('messages/wechat/sync', {});
              setNotice(result.wechat.lastError || '微信消息已检查');
            })}>立即同步</Button>
          <Button disabled={busy} onClick={() => void refresh()}>刷新状态</Button>
        </div>
      </>}
      {mode === 'settings' && tab === 'rules' && <>
        <h3>微信会话规则</h3>
        <div className="segmented message-rule-kinds">
          <button aria-pressed={kind === 'group'} onClick={() => setKind('group')}>群聊</button>
          <button aria-pressed={kind === 'private'} onClick={() => setKind('private')}>私聊</button>
        </div>
        <p className="hint">先读取微信列表，再按名称搜索并绑定会话。未命名群可按群成员姓名搜索。规则与 QQ 共用筛选、AI 推荐和待确认逻辑。</p>
        <div className="message-bulk-actions">
          <Button disabled={busy || !view.wechat?.configured} onClick={loadChats}>读取微信会话列表</Button>
          <Button disabled={busy || settings.rules.length >= 50} onClick={addRule}>添加{kind === 'group' ? '群聊' : '私聊'}规则</Button>
          <Button disabled={busy} onClick={saveRules}>保存规则</Button>
        </div>
        {!rules.length && <p className="hint">暂无微信{kind === 'group' ? '群聊' : '私聊'}规则。</p>}
        {rules.map((rule) => {
          const source = kind === 'group' ? groups : contacts;
          const bound = source.find((chat) => chat.id === rule.chatId);
          const search = (queries[rule.id] || '').trim().toLowerCase();
          const matches = search ? source.filter((chat) =>
            [chat.name, chat.remark || '', chat.alias || '', chat.id, ...(chat.members || [])]
              .some((field) => field.toLowerCase().includes(search))).slice(0, 20) : [];
          return <fieldset className="message-rule" key={rule.id}>
            <legend>{rule.name || '新会话'}</legend>
            <Field label={kind === 'group' ? '微信群' : '微信联系人'}>
              <input placeholder="输入名称或微信号搜索" value={queries[rule.id] || ''}
                onChange={(event) => setQueries({ ...queries, [rule.id]: event.target.value })} />
            </Field>
            {search && <div className="qq-group-matches" role="listbox">
              {matches.map((chat) => <button type="button" className="qq-group-match" key={chat.id}
                onClick={() => { updateRule(rule.id, { chatId: chat.id, name: chat.remark || chat.name });
                  setQueries({ ...queries, [rule.id]: '' }); }}>
                {chat.remark || chat.name}<small>{kind === 'private' && chat.alias
                  ? `微信号：${chat.alias}` : kind === 'group' && chat.memberCount
                    ? `${chat.memberCount} 人 · 内部 ID：${chat.id}` : `内部 ID：${chat.id}`}</small>
              </button>)}
              {!matches.length && <p className="hint">没有匹配的会话。</p>}
            </div>}
            {rule.chatId && <p className="hint">已绑定：{bound?.alias
              ? `微信号 ${bound.alias}（内部 ID ${rule.chatId}）`
              : `内部 ID ${rule.chatId}`} <button type="button" className="link-button"
              onClick={() => updateRule(rule.id, { chatId: null })}>取消绑定</button></p>}
            <Field label="会话名称"><input required value={rule.name}
              onChange={(event) => updateRule(rule.id, { name: event.target.value })} /></Field>
            <label><input type="checkbox" checked={rule.enabled}
              onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })} /> 启用此会话</label>
            <label><input type="checkbox" checked={aiReady && rule.useAi} disabled={!aiReady}
              onChange={(event) => updateRule(rule.id, { useAi: event.target.checked,
                autoAccept: event.target.checked ? rule.autoAccept : false })} /> 使用 AI 辅助识别</label>
            <label><input type="checkbox" checked={aiReady && rule.autoAccept} disabled={!aiReady || !rule.useAi}
              onChange={(event) => updateRule(rule.id, { autoAccept: event.target.checked })} /> 自动加入计划</label>
            {!aiReady && <p className="hint">AI 设置与 QQ 共用；请先在“QQ 同步设置 → 模型设置”中配置密钥。当前会将命中消息原样加入待确认。</p>}
            <label><input type="checkbox" checked={rule.includeSelf}
              onChange={(event) => updateRule(rule.id, { includeSelf: event.target.checked })} /> 同步本人发送的消息</label>
            <Field label="检查范围"><select value={rule.mode} onChange={(event) =>
              updateRule(rule.id, { mode: event.target.value as 'all' | 'conditions' })}>
              <option value="all">检查所有消息</option><option value="conditions">只检查符合条件的消息</option>
            </select></Field>
            {rule.mode === 'conditions' && <div className="message-conditions">
              {Object.entries(conditionLabels).map(([condition, label]) => <label key={condition}>
                <input type="checkbox" checked={rule.conditions.includes(condition as keyof typeof conditionLabels)}
                  onChange={(event) => updateRule(rule.id, { conditions: event.target.checked
                    ? [...rule.conditions, condition as keyof typeof conditionLabels]
                    : rule.conditions.filter((item) => item !== condition) })} /> {label}
              </label>)}
            </div>}
            {(['aliases', 'senders', 'keywords'] as const).map((field) => <Field key={field}
              label={{ aliases: '本会话中的别名', senders: '指定发送人', keywords: '关键词' }[field]}>
              <input value={rule[field].join('、')} placeholder="多个值用、分隔"
                onChange={(event) => updateRule(rule.id, { [field]: event.target.value.split(/[、,]/).map((part) => part.trim()).filter(Boolean) })} />
            </Field>)}
            <Field label="限定项目"><select value={rule.projectId ?? ''} onChange={(event) =>
              updateRule(rule.id, { projectId: event.target.value || null, lineId: null })}>
              <option value="">不限定</option>
              {projects.map((entry) => entry.data.type === 'project' && <option key={entry.data.id}
                value={entry.data.id}>{entry.data.title}</option>)}
            </select></Field>
            <Field label="默认业务线"><select value={rule.lineId ?? ''} onChange={(event) =>
              updateRule(rule.id, { lineId: event.target.value || null })}>
              <option value="">由 AI 推荐</option>
              {lines.filter((entry) => entry.data.type === 'workline' &&
                (!rule.projectId || entry.data.projectId === rule.projectId)).map((entry) =>
                  entry.data.type === 'workline' && <option key={entry.data.id}
                    value={entry.data.id}>{entry.data.title}</option>)}
            </select></Field>
            <Button disabled={busy} onClick={saveRules}>保存此规则</Button>
            <Button disabled={busy} onClick={() => setSettings((current) => ({ ...current,
              rules: current.rules.filter((item) => item.id !== rule.id) }))}>移除此规则</Button>
          </fieldset>;
        })}
        <h3>我的身份关键词</h3>
        <p className="hint">与 QQ 共用，用于姓名和班级条件。</p>
        {(['names', 'classes'] as const).map((field) => <Field key={field}
          label={field === 'names' ? '本人姓名与称呼' : '班级名称与简称'}>
          <input value={settings[field].join('、')} placeholder="多个值用、分隔"
            onChange={(event) => setSettings({ ...settings,
              [field]: event.target.value.split(/[、,]/).map((part) => part.trim()).filter(Boolean) })} />
        </Field>)}
        <Button disabled={busy} onClick={saveRules}>保存规则与身份关键词</Button>
      </>}
      {mode === 'pending' && <>
        {!candidates.length && <p className="hint">暂无待确认的微信消息。</p>}
        {!!candidates.length && <div className="message-bulk-actions">
          <Button disabled={busy} onClick={() => setBulk('accept')}>一键确认（{candidates.length}）</Button>
          <Button disabled={busy} onClick={() => setBulk('dismiss')}>一键忽略（{candidates.length}）</Button>
        </div>}
        {bulk && <div className="message-bulk-backdrop"><div className="message-bulk-confirm"
          role="alertdialog" aria-modal="true">
          <p>确定要一键{bulk === 'accept' ? '确认' : '忽略'}全部 {candidates.length} 条微信待确认事项吗？</p>
          <Button disabled={busy} onClick={() => setBulk(null)}>取消</Button>
          <Button disabled={busy} className="primary" onClick={() => void run(async () => {
            await api('messages/bulk', { action: bulk, provider: 'wechat', revision: view.revision });
            setBulk(null); await reload(); setNotice('已处理微信待确认事项');
          })}>确定</Button>
        </div></div>}
        {candidates.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate}
          snapshot={snapshot} busy={busy} canUseAi={aiReady}
          accept={(lineId: string, suggestion: Suggestion, projectId?: string | null) => void run(async () => {
            await api('messages/accept', { id: candidate.id, revision: view.revision, lineId,
              projectId: projectId ?? null, suggestion });
            await reload(); setNotice('已加入计划，原文已保存到业务线 Notes');
          })}
          recognize={() => void run(async () => {
            const result = await api<{ message: string }>('messages/recognize',
              { id: candidate.id, revision: view.revision });
            setNotice(result.message);
          })}
          dismiss={() => void run(async () => {
            await api('messages/dismiss', { id: candidate.id, revision: view.revision });
            setNotice('已忽略此事项');
          })} />)}
      </>}
    </section>
  );
}
