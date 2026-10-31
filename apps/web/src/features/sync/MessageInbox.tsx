import { useEffect, useState } from 'react';
import type { Snapshot } from '../../../../../packages/domain/index';
import {
  aiDefaults,
  aiProviders,
  conditionLabels,
  fallbackDestination,
  type AiProvider,
  type AiSettings,
  type InboxView,
  type MessageDestination,
  type MessageSettings,
  type MessageRule,
  type Candidate,
  type Suggestion,
} from '../../../../../packages/domain/messages';
import { api } from '../../api';
import { Button, Field, ErrorMessage } from '../../components/ui';
import { parseQuickCapture } from '../capture/quickCaptureParser';

function beijingInput(date: Date) {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16).replace(' ', 'T');
}

function beijingEpoch(value: string) {
  const normalized = value.length === 16 ? `${value}:00` : value;
  return Math.floor(new Date(`${normalized}+08:00`).getTime() / 1000);
}

const catalogOf = (snapshot: Snapshot) =>
  snapshot.entries.flatMap(({ data: p }) =>
    p.type === 'project' && !p.completedAt
      ? [
          {
            id: p.id,
            title: p.title,
            lines: snapshot.entries.flatMap(({ data: l }) =>
              l.type === 'workline' && l.projectId === p.id && !l.completedAt
                ? [{ id: l.id, title: l.title }]
                : [],
            ),
          },
        ]
      : [],
  );

type DestinationDraft =
  | { kind: 'none'; lineId: string }
  | { kind: 'newLine'; projectId: string; projectTitle: string; lineTitle: string }
  | { kind: 'newProject'; projectTitle: string; lineTitle: string };

function destinationDraft(
  candidate: Candidate,
  usable: MessageDestination | null,
  snapshot: Snapshot,
): DestinationDraft {
  if (candidate.lineId) return { kind: 'none', lineId: candidate.lineId };
  if (usable?.kind === 'existing') return { kind: 'none', lineId: usable.lineId };
  const catalog = catalogOf(snapshot);
  const scoped = candidate.projectId
    ? catalog.find((project) => project.id === candidate.projectId)
    : undefined;
  if (usable?.kind === 'newLine') {
    const parent = catalog.find((project) => project.id === usable.projectId);
    if (parent)
      return {
        kind: 'newLine',
        projectId: parent.id,
        projectTitle: parent.title,
        lineTitle: usable.lineTitle,
      };
  }
  if (usable?.kind === 'newProject' && scoped)
    return {
      kind: 'newLine',
      projectId: scoped.id,
      projectTitle: scoped.title,
      lineTitle: usable.lineTitle,
    };
  if (usable?.kind === 'newProject')
    return {
      kind: 'newProject',
      projectTitle: usable.projectTitle,
      lineTitle: usable.lineTitle,
    };
  const fallback = fallbackDestination(
    candidate.suggestion.title,
    candidate.source.text,
    catalog,
    scoped?.id ?? null,
  );
  if (fallback.kind === 'existing') return { kind: 'none', lineId: fallback.lineId };
  if (fallback.kind === 'newLine') {
    const parent = catalog.find((project) => project.id === fallback.projectId);
    return {
      kind: 'newLine',
      projectId: fallback.projectId,
      projectTitle: parent?.title ?? '已有项目',
      lineTitle: fallback.lineTitle,
    };
  }
  return {
    kind: 'newProject',
    projectTitle: fallback.projectTitle,
    lineTitle: fallback.lineTitle,
  };
}

const split = (text: string) => [
  ...new Set(
    text
      .split(/[\n,，]/)
      .map((t) => t.trim())
      .filter(Boolean),
  ),
];
function Terms({
  label,
  values,
  change,
}: {
  label: string;
  values: string[];
  change: (values: string[]) => void;
}) {
  const [text, setText] = useState(values.join('，'));
  useEffect(() => setText(values.join('，')), [values.join('\n')]);
  return (
    <Field label={label}>
      <input
        value={text}
        placeholder="多个值用逗号分隔"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => change(split(text))}
      />
    </Field>
  );
}
function ProjectSelect({
  snapshot,
  value,
  change,
}: {
  snapshot: Snapshot;
  value: string;
  change: (id: string) => void;
}) {
  return (
    <Field label="限定项目（可选）">
      <select value={value} onChange={(e) => change(e.target.value)}>
        <option value="">不限定（可跨项目）</option>
        {snapshot.entries.map((e) =>
          e.data.type === 'project' && !e.data.completedAt ? (
            <option key={e.data.id} value={e.data.id}>
              {e.data.title}
            </option>
          ) : null,
        )}
      </select>
    </Field>
  );
}
function LineSelect({
  snapshot,
  projectId,
  value,
  change,
}: {
  snapshot: Snapshot;
  projectId?: string | null;
  value: string;
  change: (id: string) => void;
}) {
  const projects = new Map(
    snapshot.entries
      .filter((e) => e.data.type === 'project' && !e.data.completedAt)
      .map((e) => [e.data.id, e.data]),
  );
  return (
    <Field label="默认业务线（可选）">
      <select value={value} onChange={(e) => change(e.target.value)}>
        <option value="">不指定，由 AI 决定</option>
        {snapshot.entries.map((e) =>
          e.data.type === 'workline' &&
          !e.data.completedAt &&
          projects.has(e.data.projectId) &&
          (!projectId || e.data.projectId === projectId) ? (
            <option key={e.data.id} value={e.data.id}>
              {'title' in projects.get(e.data.projectId)!
                ? (projects.get(e.data.projectId)! as { title: string }).title
                : ''}{' '}
              / {e.data.title}
            </option>
          ) : null,
        )}
      </select>
    </Field>
  );
}
function QqGroupPicker({
  groups,
  value,
  onSelect,
}: {
  groups: { id: string; name: string }[];
  value: string;
  onSelect: (group: { id: string; name: string } | null) => void;
}) {
  const [query, setQuery] = useState('');
  const selected = groups.find((group) => group.id === value);
  const normalized = query.trim().normalize('NFKC').toLowerCase();
  const matches = normalized
    ? groups
        .filter(
          (group) =>
            group.name.normalize('NFKC').toLowerCase().includes(normalized) ||
            group.id.includes(normalized),
        )
        .slice(0, 20)
    : [];
  return (
    <>
      <Field label="QQ 群">
        <input
          value={query}
          placeholder={selected ? `${selected.name}（${selected.id}）` : '输入群名或群号搜索'}
          onChange={(e) => setQuery(e.target.value)}
        />
      </Field>
      {normalized && (
        <div className="qq-group-matches" role="listbox" aria-label="匹配的 QQ 群">
          {matches.length ? (
            matches.map((group) => (
              <button
                key={group.id}
                type="button"
                className="qq-group-match"
                onClick={() => {
                  onSelect(group);
                  setQuery('');
                }}
              >
                <span>{group.name}</span>
                <small>{group.id}</small>
              </button>
            ))
          ) : (
            <p className="hint">没有匹配的群；请确认已读取 QQ 列表。</p>
          )}
        </div>
      )}
      {value && (
        <p className="hint">
          已绑定：{selected ? `${selected.name}（${selected.id}）` : value}
          <button type="button" className="qq-group-clear" onClick={() => onSelect(null)}>
            取消绑定
          </button>
        </p>
      )}
      {!groups.length && <p className="hint">先在上方“读取 QQ 列表”，再输入群名或群号搜索。</p>}
    </>
  );
}

function QqContactPicker({
  contacts,
  value,
  onSelect,
}: {
  contacts: { id: string; name: string; remark: string }[];
  value: string;
  onSelect: (contact: { id: string; name: string; remark: string } | null) => void;
}) {
  const [query, setQuery] = useState('');
  const selected = contacts.find((contact) => contact.id === value);
  const normalized = query.trim().normalize('NFKC').toLowerCase();
  const matches = normalized
    ? contacts
        .filter((contact) =>
          [contact.name, contact.remark, contact.id].some((field) =>
            field.normalize('NFKC').toLowerCase().includes(normalized),
          ),
        )
        .slice(0, 20)
    : [];
  return (
    <>
      <Field label="QQ 联系人">
        <input
          value={query}
          placeholder={
            selected
              ? `${selected.remark || selected.name}（${selected.id}）`
              : '输入原名、备注或 QQ 号搜索'
          }
          onChange={(e) => setQuery(e.target.value)}
        />
      </Field>
      {normalized && (
        <div className="qq-group-matches" role="listbox" aria-label="匹配的 QQ 联系人">
          {matches.length ? (
            matches.map((contact) => (
              <button
                key={contact.id}
                type="button"
                className="qq-group-match"
                onClick={() => {
                  onSelect(contact);
                  setQuery('');
                }}
              >
                <span>{contact.remark || contact.name}</span>
                <small>
                  {contact.remark && contact.name && contact.remark !== contact.name
                    ? `${contact.name} · ${contact.id}`
                    : contact.id}
                </small>
              </button>
            ))
          ) : (
            <p className="hint">没有匹配的联系人；请确认已读取 QQ 列表。</p>
          )}
          {/^\d{5,12}$/.test(normalized) &&
            !matches.some((contact) => contact.id === normalized) && (
              <button
                type="button"
                className="qq-group-match"
                onClick={() => {
                  onSelect({ id: normalized, name: normalized, remark: '' });
                  setQuery('');
                }}
              >
                <span>使用 QQ 号 {normalized}</span>
                <small>联系人列表中没有该 QQ 时仍可绑定</small>
              </button>
            )}
        </div>
      )}
      {value && (
        <p className="hint">
          已绑定：{selected ? `${selected.remark || selected.name}（${selected.id}）` : value}
          {' · '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              onSelect(null);
              setQuery('');
            }}
          >
            取消绑定
          </button>
        </p>
      )}
      {!contacts.length && (
        <p className="hint">先在上方“读取 QQ 列表”，再输入原名、备注或 QQ 号搜索。</p>
      )}
    </>
  );
}

function CandidateCard({
  candidate,
  snapshot,
  busy,
  accept,
  dismiss,
  recognize,
  canUseAi,
}: {
  candidate: Candidate;
  snapshot: Snapshot;
  busy: boolean;
  accept: (line: string, suggestion: Suggestion, projectId?: string | null) => void;
  dismiss: () => void;
  recognize: () => void;
  canUseAi: boolean;
}) {
  const [suggestion, setSuggestion] = useState(() =>
    candidate.raw
      ? {
          ...candidate.suggestion,
          title: parseQuickCapture(candidate.source.text, snapshot.entries).title,
        }
      : candidate.suggestion,
  );
  const recommended = candidate.suggestion.destination;
  const recommendedLine =
    recommended?.kind === 'existing'
      ? snapshot.entries.find(
          (e) =>
            e.data.type === 'workline' && e.data.id === recommended.lineId && !e.data.completedAt,
        )
      : undefined;
  const recommendedLineData =
    recommendedLine?.data.type === 'workline' ? recommendedLine.data : undefined;
  const recommendedParent =
    recommended?.kind === 'newLine'
      ? snapshot.entries.find(
          (e) =>
            e.data.type === 'project' && e.data.id === recommended.projectId && !e.data.completedAt,
        )
      : undefined;
  const usable =
    recommended == null
      ? null
      : recommended.kind === 'existing'
        ? recommendedLineData
          ? recommended
          : null
        : recommended.kind === 'newLine'
          ? recommendedParent
            ? recommended
            : null
          : recommended;
  const raw = candidate.raw;
  const draft: DestinationDraft = raw
    ? { kind: 'none', lineId: candidate.lineId ?? '' }
    : destinationDraft(candidate, usable, snapshot);
  const [projectId, setProjectId] = useState(draft.kind === 'newLine' ? draft.projectId : '');
  const [projectTitle, setProjectTitle] = useState(
    draft.kind === 'newProject' ? draft.projectTitle : '',
  );
  const [lineTitle, setLineTitle] = useState(draft.kind === 'none' ? '' : draft.lineTitle);
  const chosenLine =
    draft.kind === 'none' && !candidate.lineId
      ? snapshot.entries.find((e) => e.data.id === draft.lineId && e.data.type === 'workline')
      : undefined;
  const chosenLineData = chosenLine?.data.type === 'workline' ? chosenLine.data : undefined;
  const chosenProject = chosenLineData
    ? snapshot.entries.find(
        (e) => e.data.type === 'project' && e.data.id === chosenLineData.projectId,
      )
    : undefined;
  const chosenProjectTitle = chosenProject?.data.type === 'project' ? chosenProject.data.title : '';
  const recommendation =
    draft.kind === 'none'
      ? candidate.lineId
        ? '已使用会话默认业务线。'
        : chosenLineData
          ? `AI 推荐现有业务线：${chosenProjectTitle ? chosenProjectTitle + ' / ' : ''}${chosenLineData.title}`
          : '将归入现有业务线。'
      : draft.kind === 'newLine'
        ? `AI 推荐在「${draft.projectTitle}」下新建业务线，可修改名称。`
        : 'AI 推荐新建项目与业务线，可修改名称。';
  const destination: MessageDestination | null =
    draft.kind === 'newLine'
      ? {
          kind: 'newLine',
          projectId,
          lineTitle: lineTitle.trim(),
          reason: usable?.reason ?? 'AI 推荐',
        }
      : draft.kind === 'newProject'
        ? {
            kind: 'newProject',
            projectTitle: projectTitle.trim(),
            lineTitle: lineTitle.trim(),
            reason: usable?.reason ?? 'AI 推荐',
          }
        : null;
  const targetLineId = draft.kind === 'none' ? draft.lineId : '';
  const [actions, setActions] = useState(candidate.suggestion.actions.join('\n'));
  const lineEntry = candidate.lineId
    ? snapshot.entries.find((entry) => entry.data.id === candidate.lineId)
    : undefined;
  const [rawProjectId, setRawProjectId] = useState(
    candidate.projectId ?? (lineEntry?.data.type === 'workline' ? lineEntry.data.projectId : ''),
  );
  const [rawLineId, setRawLineId] = useState(candidate.lineId ?? '');
  const [quickText, setQuickText] = useState(candidate.source.text);
  const canAdd = ['task', 'event'].includes(candidate.suggestion.kind);
  const rawProjects = snapshot.entries.flatMap((entry) =>
    entry.data.type === 'project' && !entry.data.completedAt
      ? [{ id: entry.data.id, title: entry.data.title }]
      : [],
  );
  const rawLines = snapshot.entries.flatMap((entry) =>
    entry.data.type === 'workline' &&
    !entry.data.completedAt &&
    (!rawProjectId || entry.data.projectId === rawProjectId)
      ? [{ id: entry.data.id, title: entry.data.title }]
      : [],
  );
  const isChange = candidate.suggestion.kind === 'change';
  const isCancel = candidate.suggestion.kind === 'cancel';
  const isCompleted = isChange && suggestion.completed;
  const targetEntry = suggestion.targetId
    ? snapshot.entries.find((entry) => entry.data.id === suggestion.targetId)
    : undefined;
  const target =
    targetEntry?.data.type === 'milestone' || targetEntry?.data.type === 'todo'
      ? targetEntry.data
      : undefined;
  return (
    <article className="message-candidate">
      <h3>{candidate.suggestion.title}</h3>
      <p className="hint">
        {candidate.conversation} · {candidate.source.sender} ·{' '}
        {new Date(candidate.source.sentAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
      </p>
      <p>{candidate.suggestion.reason}</p>
      {candidate.suggestion.uncertainty && (
        <p className="message-notice">需要核对：{candidate.suggestion.uncertainty}</p>
      )}
      {(suggestion.tags.length > 0 || suggestion.location) && (
        <p className="hint">
          {suggestion.tags.length > 0 ? `节点标签：${suggestion.tags.join('、')}` : ''}
          {suggestion.tags.length > 0 && suggestion.location ? ' · ' : ''}
          {suggestion.location ? `地点：${suggestion.location}` : ''}
        </p>
      )}
      <details>
        <summary>查看原文</summary>
        <blockquote>{candidate.source.text}</blockquote>
        {candidate.source.context && (
          <>
            <p>补充上下文</p>
            <blockquote>{candidate.source.context}</blockquote>
          </>
        )}
      </details>
      {canAdd ? (
        <>
          <Field label="事项标题">
            <input
              value={suggestion.title}
              onChange={(e) => setSuggestion({ ...suggestion, title: e.target.value })}
            />
          </Field>
          {raw && (
            <>
              <p className="hint">
                这条消息未使用 AI，请设置项目、业务线和日期；也可以直接点“用 AI 识别”补全。
              </p>
              <details>
                <summary>快速处理（本地解析，不调用 AI）</summary>
                <Field label="快速处理文字">
                  <textarea
                    rows={3}
                    value={quickText}
                    onChange={(e) => setQuickText(e.target.value)}
                  />
                </Field>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const parsed = parseQuickCapture(quickText, snapshot.entries);
                    setSuggestion({
                      ...suggestion,
                      title: parsed.title,
                      dueDate: parsed.dueDate,
                      dueTime: parsed.dueTime,
                      tags: parsed.tags,
                    });
                    if (parsed.lineId) {
                      const line = snapshot.entries.find(
                        (entry) => entry.data.id === parsed.lineId,
                      );
                      if (line?.data.type === 'workline') {
                        setRawLineId(line.data.id);
                        setRawProjectId(line.data.projectId);
                      }
                    }
                  }}
                >
                  解析并填入
                </Button>
                <p className="hint">只使用本地脚本提取日期、时刻、标签和可能业务线。</p>
              </details>
              <div className="message-fields">
                <Field label="项目">
                  <select
                    value={rawProjectId}
                    onChange={(e) => {
                      const projectId = e.target.value;
                      const line = snapshot.entries.find(
                        (entry) => entry.data.id === rawLineId && entry.data.type === 'workline',
                      );
                      setRawProjectId(projectId);
                      if (
                        projectId &&
                        line?.data.type === 'workline' &&
                        line.data.projectId !== projectId
                      )
                        setRawLineId('');
                    }}
                  >
                    <option value="">不指定</option>
                    {rawProjects.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.title}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="业务线">
                  <select value={rawLineId} onChange={(e) => setRawLineId(e.target.value)}>
                    <option value="">不指定</option>
                    {rawLines.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.title}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Button type="button" disabled={busy || !canUseAi} onClick={recognize}>
                用 AI 识别
              </Button>
              {!canUseAi && <p className="hint">需先配置可用的 AI API 密钥，才能使用 AI 识别。</p>}
            </>
          )}
          {!raw && (
            <p className="hint">
              {recommendation}
              {!candidate.lineId && usable?.reason ? `（依据：${usable.reason}）` : ''}
            </p>
          )}
          {draft.kind === 'newLine' && (
            <>
              <p className="hint">
                所属项目：{draft.projectTitle}
                {candidate.projectId ? '（会话限定项目）' : ''}。将在此项目下新建业务线。
              </p>
              <Field label="新业务线名称">
                <input
                  required
                  maxLength={300}
                  value={lineTitle}
                  onChange={(e) => setLineTitle(e.target.value)}
                />
              </Field>
            </>
          )}
          {draft.kind === 'newProject' && (
            <>
              <Field label="新项目名称">
                <input
                  required
                  maxLength={300}
                  value={projectTitle}
                  onChange={(e) => setProjectTitle(e.target.value)}
                />
              </Field>
              <Field label="新业务线名称">
                <input
                  required
                  maxLength={300}
                  value={lineTitle}
                  onChange={(e) => setLineTitle(e.target.value)}
                />
              </Field>
              <p className="hint">确认时创建；存在唯一同名项目／业务线时会复用。</p>
            </>
          )}
          <div className="message-fields">
            <Field label="事项类型">
              <select
                value={suggestion.kind}
                onChange={(e) =>
                  setSuggestion({ ...suggestion, kind: e.target.value as 'task' | 'event' })
                }
              >
                <option value="task">行动待办</option>
                <option value="event">事件或截止节点</option>
              </select>
            </Field>
            <Field label="日期">
              <input
                type="date"
                value={suggestion.dueDate ?? ''}
                onChange={(e) =>
                  setSuggestion({
                    ...suggestion,
                    dueDate: e.target.value || null,
                    dueTime: e.target.value ? suggestion.dueTime : null,
                  })
                }
              />
            </Field>
            <Field label="时刻">
              <input
                type="time"
                disabled={!suggestion.dueDate}
                value={suggestion.dueTime ?? ''}
                onChange={(e) => setSuggestion({ ...suggestion, dueTime: e.target.value || null })}
              />
            </Field>
          </div>
          {!raw && (
            <Field label="行动清单（每行一项）">
              <textarea rows={3} value={actions} onChange={(e) => setActions(e.target.value)} />
            </Field>
          )}
          <p className="hint">
            有日期或时刻的要求会建立节点；无日期行动进入待办池。确认不会生成实际工作记录。
          </p>
          <Button
            disabled={
              busy ||
              !suggestion.title.trim() ||
              (draft.kind !== 'none' &&
                (!lineTitle.trim() || (draft.kind === 'newProject' && !projectTitle.trim())))
            }
            onClick={() =>
              accept(
                raw ? rawLineId : targetLineId,
                {
                  ...suggestion,
                  destination: raw ? null : destination,
                  actions: actions
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean),
                },
                raw ? rawProjectId || null : null,
              )
            }
          >
            确认加入计划
          </Button>
        </>
      ) : (
        <>
          <p className="message-notice">
            这是{isCancel ? '取消' : isCompleted ? '完成确认' : '变更'}建议：
            {target
              ? `「${target.title}」${
                  target.type === 'milestone'
                    ? ` 当前 ${target.dueDate ?? '无日期'} ${target.dueTime ?? ''}`
                    : ` 当前 ${target.dueDate ?? '无日期'}`
                }`
              : '未找到对应事项，确认前请核对'}
          </p>
          {isCompleted && <p className="hint">确认后把原事项标记为完成，不修改日期。</p>}
          {isChange && !isCompleted && target && (
            <div className="message-fields">
              <Field label="修改后的日期">
                <input
                  type="date"
                  value={suggestion.dueDate ?? ''}
                  onChange={(e) =>
                    setSuggestion({
                      ...suggestion,
                      dueDate: e.target.value || null,
                      dueTime: e.target.value ? suggestion.dueTime : null,
                    })
                  }
                />
              </Field>
              {target.type === 'milestone' && (
                <Field label="修改后的时刻">
                  <input
                    type="time"
                    disabled={!suggestion.dueDate}
                    value={suggestion.dueTime ?? ''}
                    onChange={(e) =>
                      setSuggestion({ ...suggestion, dueTime: e.target.value || null })
                    }
                  />
                </Field>
              )}
            </div>
          )}
          {isCancel && <p className="hint">取消会把原事项标记为完成，原文和 Notes 保留。</p>}
          <Button
            disabled={busy || !target}
            onClick={() =>
              accept('', {
                ...suggestion,
                dueTime: target?.type === 'todo' ? null : suggestion.dueTime,
                destination: null,
                actions: suggestion.actions.map((value) => value.trim()).filter(Boolean),
              })
            }
          >
            {isCancel ? '确认取消' : isCompleted ? '确认完成' : '确认修改'}
          </Button>
        </>
      )}
      <Button disabled={busy} onClick={dismiss}>
        {canAdd ? '忽略' : '已处理，关闭建议'}
      </Button>
    </article>
  );
}

export function MessageInbox({
  snapshot,
  reload,
  onPendingChange,
}: {
  snapshot: Snapshot;
  reload: () => Promise<void>;
  onPendingChange?: (count: number) => void;
}) {
  const [view, setView] = useState<InboxView | null>(null);
  const [settings, setSettings] = useState<MessageSettings>({ names: [], classes: [], rules: [] });
  const [tab, setTab] = useState<'inbox' | 'manual' | 'global' | 'model' | 'rules'>('inbox');
  const [ruleKindTab, setRuleKindTab] = useState<'group' | 'private'>('group');
  const [collapsedRules, setCollapsedRules] = useState<Set<string>>(() => new Set());
  const [bulk, setBulk] = useState<'accept' | 'dismiss' | null>(null);
  const [quickRuleId, setQuickRuleId] = useState('');
  const [quickInput, setQuickInput] = useState('');
  const [quickParsed, setQuickParsed] = useState<ReturnType<typeof parseQuickCapture> | null>(null);
  const [manual, setManual] = useState(() => {
    const now = new Date();
    return {
      ruleId: '',
      from: beijingInput(new Date(now.getTime() - 7 * 86400000)),
      to: beijingInput(now),
      includeSelf: false,
      autoAccept: false,
      resyncSeen: false,
      useAi: true,
    };
  });
  const [ai, setAi] = useState<AiSettings>({
    provider: 'deepseek',
    baseUrl: aiDefaults.deepseek.baseUrl,
    model: aiDefaults.deepseek.model,
    jsonMode: true,
  });
  const [key, setKey] = useState('');
  const [qq, setQq] = useState({
    enabled: false,
    dataDir: '',
    python: 'py -3.12',
    intervalSeconds: 30,
    backfillDays: 7,
    selfQQ: '',
  });
  const [qqKey, setQqKey] = useState('');
  const [qqGroups, setQqGroups] = useState<{ id: string; name: string }[]>([]);
  const [qqContacts, setQqContacts] = useState<{ id: string; name: string; remark: string }[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState({
    ruleId: '',
    sender: '',
    sentAt: '',
    text: '',
    context: '',
    atAll: false,
    atMe: false,
  });
  const refresh = async () => {
    const next = await api<InboxView>('messages');
    setView(next);
    onPendingChange?.(next.state.candidates.length);
    const active = next.ai.profiles[next.ai.provider];
    setSettings({
      ...next.state.settings,
      rules: next.state.settings.rules.map((rule) =>
        active.ready ? rule : { ...rule, useAi: false, autoAccept: false },
      ),
    });
    setManual((current) => ({
      ...current,
      useAi: active.ready ? current.useAi : false,
      autoAccept: active.ready ? current.autoAccept : false,
    }));
    setAi({
      provider: next.ai.provider,
      baseUrl: active.baseUrl,
      model: active.model,
      jsonMode: active.jsonMode,
    });
    setQq({
      enabled: next.qq.enabled,
      dataDir: next.qq.dataDir,
      python: next.qq.python,
      intervalSeconds: next.qq.intervalSeconds,
      backfillDays: next.qq.backfillDays,
      selfQQ: next.qq.selfQQ,
    });
  };
  const loadGroups = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{
        groups: { id: string; name: string }[];
        contacts: { id: string; name: string; remark: string }[];
      }>('messages/qq/groups');
      setQqGroups(result.groups);
      setQqContacts(result.contacts ?? []);
      setNotice(
        `已读取 ${result.groups.length} 个 QQ 群和 ${result.contacts?.length ?? 0} 个联系人`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const changeProvider = (provider: AiProvider) => {
    const profile = view!.ai.profiles[provider];
    const fallback = aiDefaults[provider];
    setAi({
      provider,
      baseUrl: profile.baseUrl || fallback.baseUrl,
      model: profile.model || fallback.model,
      jsonMode: profile.jsonMode,
    });
    setKey('');
  };
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, [snapshot.vaultId]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const updateRule = (id: string, update: Partial<MessageRule>) =>
    setSettings((s) => ({
      ...s,
      rules: s.rules.map((r) => (r.id === id ? { ...r, ...update } : r)),
    }));
  const saveSettings = (message = '规则已保存') =>
    void run(async () => {
      await api('messages/settings', { settings, revision: view?.revision ?? null });
      setNotice(message);
    });
  const addRule = (kind: 'group' | 'private' = 'group') =>
    setSettings((s) => ({
      ...s,
      rules: [
        {
          id: crypto.randomUUID(),
          name: '',
          kind,
          enabled: kind === 'group',
          useAi: true,
          autoAccept: false,
          includeSelf: false,
          mode: 'all',
          conditions: [],
          senders: [],
          keywords: [],
          aliases: [],
          projectId: null,
          chatId: null,
          lineId: null,
        },
        ...s.rules,
      ],
    }));
  const toggleRule = (id: string) =>
    setCollapsedRules((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const groupRuleCount = settings.rules.filter((rule) => rule.kind === 'group').length;
  const privateRuleCount = settings.rules.filter((rule) => rule.kind === 'private').length;
  const visibleRules = settings.rules.filter((rule) => rule.kind === ruleKindTab);
  if (!view)
    return (
      <>
        <p>正在读取 QQ 同步…</p>
        <ErrorMessage message={error} />
      </>
    );
  const activeAi = view.ai.profiles[view.ai.provider];
  const aiLabel = aiDefaults[view.ai.provider].label;
  const selected = view.ai.profiles[ai.provider];
  const keyStatus = selected.keySaved
    ? '密钥已保存'
    : selected.keyFromEnv
      ? `密钥来自环境变量 ${aiDefaults[ai.provider].env}`
      : '密钥未配置';
  const aiDirty =
    ai.provider !== view.ai.provider ||
    ai.baseUrl.trim() !== selected.baseUrl ||
    ai.model.trim() !== selected.model ||
    ai.jsonMode !== selected.jsonMode ||
    Boolean(key.trim());
  return (
    <section className="message-inbox" aria-label="QQ 自动同步">
      <p className="message-notice" role="status">
        支持本机 QQ
        自动同步：在设置中启用并绑定群或私聊联系人后，会定时读取新消息；也可粘贴消息手工验证。未绑定的会话不会自动读取。
      </p>
      <div className="segmented">
        <button aria-pressed={tab === 'inbox'} onClick={() => setTab('inbox')}>
          待确认（{view.state.candidates.length}）
        </button>
        <button aria-pressed={tab === 'manual'} onClick={() => setTab('manual')}>
          QQ手动同步
        </button>
        <button aria-pressed={tab === 'global'} onClick={() => setTab('global')}>
          QQ自动同步全局设置
        </button>
        <button aria-pressed={tab === 'model'} onClick={() => setTab('model')}>
          模型设置
        </button>
        <button aria-pressed={tab === 'rules'} onClick={() => setTab('rules')}>
          会话规则设置
        </button>
      </div>
      <ErrorMessage message={error} />
      {notice && <p role="status">{notice}</p>}
      {tab === 'manual' ? (
        <>
          <h3>QQ 手动同步</h3>
          <p className="hint">
            选择一个已绑定 QQ
            的会话规则，再指定时间段；只读取该范围，不移动自动同步游标。已处理过的消息不会重复。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const from = beijingEpoch(manual.from);
              const to = beijingEpoch(manual.to);
              if (!manual.ruleId) {
                setError('请先选择会话');
                return;
              }
              if (!(from < to)) {
                setError('结束时间必须晚于开始时间');
                return;
              }
              void run(async () => {
                const result = await api<{ message: string }>('messages/qq/manual', {
                  ruleId: manual.ruleId,
                  from,
                  to,
                  includeSelf: manual.includeSelf,
                  autoAccept: manual.autoAccept,
                  resyncSeen: manual.resyncSeen,
                  useAi: manual.useAi,
                });
                setNotice(result.message);
              });
            }}
          >
            <Field label="会话">
              <select
                required
                value={manual.ruleId}
                onChange={(e) => setManual({ ...manual, ruleId: e.target.value })}
              >
                <option value="">选择已绑定 QQ 的会话</option>
                {view.state.settings.rules
                  .filter((rule) => rule.chatId)
                  .map((rule) => (
                    <option key={rule.id} value={rule.id}>
                      {rule.kind === 'group' ? '群聊' : '私聊'} · {rule.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="开始时间（北京时间）">
              <input
                required
                type="datetime-local"
                value={manual.from}
                onChange={(e) => setManual({ ...manual, from: e.target.value })}
              />
            </Field>
            <Field label="结束时间（北京时间）">
              <input
                required
                type="datetime-local"
                value={manual.to}
                onChange={(e) => setManual({ ...manual, to: e.target.value })}
              />
            </Field>
            <label>
              <input
                type="checkbox"
                checked={manual.includeSelf}
                onChange={(e) => setManual({ ...manual, includeSelf: e.target.checked })}
              />
              同步本人发送的消息
            </label>
            <label>
              <input
                type="checkbox"
                checked={activeAi.ready && manual.useAi}
                disabled={!activeAi.ready}
                onChange={(e) =>
                  setManual({
                    ...manual,
                    useAi: e.target.checked,
                    ...(e.target.checked ? {} : { autoAccept: false }),
                  })
                }
              />
              使用 AI 辅助日程添加
            </label>
            {!activeAi.ready && (
              <p className="hint">
                需先在“AI 模型”中配置可用的 API 密钥，才可使用 AI 辅助；当前会按未使用 AI 处理。
              </p>
            )}
            <label>
              <input
                type="checkbox"
                checked={activeAi.ready && manual.autoAccept}
                disabled={!activeAi.ready || !manual.useAi}
                onChange={(e) => setManual({ ...manual, autoAccept: e.target.checked })}
              />
              自动加入计划（跳过待确认）
            </label>
            {activeAi.ready && !manual.useAi && (
              <p className="hint">
                未使用 AI 时只读取并加入待确认，不会自动加入计划；可在卡片上再点“用 AI 识别”。
              </p>
            )}
            <label>
              <input
                type="checkbox"
                checked={manual.resyncSeen}
                onChange={(e) => setManual({ ...manual, resyncSeen: e.target.checked })}
              />
              同步已经同步过的消息
            </label>
            <Button className="primary" disabled={busy || !manual.ruleId}>
              开始手动同步
            </Button>
          </form>
        </>
      ) : tab === 'model' ? (
        <>
          <h3>模型设置</h3>
          <p className="hint">
            用于识别消息。可选 DeepSeek、OpenAI / ChatGPT 或其他 OpenAI
            兼容接口。设置与各提供商密钥保存在本机用户配置目录（{view.ai.location}），不会写入
            Markdown 工作目录、浏览器存储或备份。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await api<{ message: string }>('messages/ai', {
                  ...ai,
                  baseUrl: ai.baseUrl.trim(),
                  model: ai.model.trim(),
                  key: key.trim() || undefined,
                });
                setKey('');
                setNotice(result.message);
              });
            }}
          >
            <Field label="模型提供商">
              <select
                value={ai.provider}
                onChange={(e) => changeProvider(e.target.value as AiProvider)}
              >
                {aiProviders.map((provider) => (
                  <option key={provider} value={provider}>
                    {aiDefaults[provider].label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="接口地址">
              <input
                required
                value={ai.baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(e) => setAi({ ...ai, baseUrl: e.target.value })}
              />
            </Field>
            <Field label="模型名称">
              <input
                required
                value={ai.model}
                placeholder={
                  ai.provider === 'openai'
                    ? '例如 gpt-4.1-mini 或你账号可用的模型'
                    : ai.provider === 'deepseek'
                      ? 'deepseek-flash'
                      : '填写接口要求的模型名'
                }
                onChange={(e) => setAi({ ...ai, model: e.target.value })}
              />
            </Field>
            <label>
              <input
                type="checkbox"
                checked={ai.jsonMode}
                onChange={(e) => setAi({ ...ai, jsonMode: e.target.checked })}
              />
              使用 JSON 输出模式（接口不支持时可关闭）
            </label>
            <Field label="API 密钥">
              <input
                type="password"
                autoComplete="off"
                placeholder={selected.keySaved ? '已保存；输入新密钥可替换' : 'sk-…'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>
            <p className="hint">
              {aiDefaults[ai.provider].label}：{keyStatus}。
              {selected.ready
                ? '当前配置可用于识别。'
                : !ai.model.trim() || !ai.baseUrl.trim()
                  ? '请填写接口地址和模型名称并保存。'
                  : '请保存此提供商的 API 密钥。'}
              {aiDirty ? ' 有未保存的修改。' : ''}
            </p>
            <Button disabled={busy || !ai.model.trim() || !ai.baseUrl.trim()}>保存 AI 设置</Button>
          </form>
          {selected.keySaved && (
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ message: string }>('messages/ai', {
                    ...ai,
                    baseUrl: ai.baseUrl.trim(),
                    model: ai.model.trim(),
                    key: '',
                  });
                  setNotice(result.message);
                })
              }
            >
              清除此提供商的密钥
            </Button>
          )}
        </>
      ) : tab === 'global' ? (
        <>
          <h3>QQ 自动同步全局设置</h3>
          <p className="hint">
            读取本机 QQ 的
            nt_msg.db，只同步选中的群或私聊联系人；登录后补下来的离线消息会按原始时间进入识别流程。
            设置与密钥保存在本机配置目录，不写入 Markdown。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await api<{ message: string }>('messages/qq/config', {
                  ...qq,
                  key: qqKey.trim() || undefined,
                });
                setQqKey('');
                setNotice(result.message);
              });
            }}
          >
            <label>
              <input
                type="checkbox"
                checked={qq.enabled}
                onChange={(e) => setQq({ ...qq, enabled: e.target.checked })}
              />
              启用后台自动同步
            </label>
            <Field label="QQ 数据目录">
              <input
                required
                value={qq.dataDir}
                placeholder="例如 D:\...\123456789\nt_qq"
                onChange={(e) => setQq({ ...qq, dataDir: e.target.value })}
              />
            </Field>
            <Field label="本人 QQ 号">
              <input
                value={qq.selfQQ}
                placeholder="用于排除自己发送的消息"
                onChange={(e) => setQq({ ...qq, selfQQ: e.target.value })}
              />
            </Field>
            <Field label="同步间隔（秒）">
              <input
                type="number"
                min={10}
                max={3600}
                value={qq.intervalSeconds}
                onChange={(e) => setQq({ ...qq, intervalSeconds: Number(e.target.value) || 30 })}
              />
            </Field>
            <Field label="首次回填天数">
              <input
                type="number"
                min={1}
                max={365}
                value={qq.backfillDays}
                onChange={(e) => setQq({ ...qq, backfillDays: Number(e.target.value) || 7 })}
              />
            </Field>
            <Field label="Python 命令">
              <input value={qq.python} onChange={(e) => setQq({ ...qq, python: e.target.value })} />
            </Field>
            <Field label="QQ 数据库密钥">
              <input
                type="password"
                autoComplete="off"
                placeholder={view.qq.keySaved ? '已保存；输入新密钥可替换' : '16 位密钥'}
                value={qqKey}
                onChange={(e) => setQqKey(e.target.value)}
              />
            </Field>
            <Button disabled={busy || !qq.dataDir.trim()}>保存 QQ 设置</Button>
          </form>
          <div className="message-fields">
            <Button
              type="button"
              disabled={busy || !view.qq.configured}
              onClick={() =>
                void run(async () => {
                  const result = await api<{
                    groupMessages: number;
                    privateMessages: number;
                  }>('messages/qq/test', {});
                  setNotice(
                    `QQ 数据库可读：群消息 ${result.groupMessages} 条，私聊 ${result.privateMessages} 条`,
                  );
                })
              }
            >
              测试读取
            </Button>
            <Button
              type="button"
              disabled={busy || !view.qq.configured || view.qq.running}
              onClick={() =>
                void run(async () => {
                  await api('messages/qq/sync', {});
                  setNotice('已检查新消息');
                })
              }
            >
              立即同步
            </Button>
          </div>
          <p className="hint">
            状态：
            {view.qq.configured ? (view.qq.enabled ? '已启用' : '已配置，未启用') : '未配置'}
            {view.qq.running ? ' · 正在同步' : ''}
            {view.qq.lastSyncAt
              ? ` · 上次同步 ${new Date(view.qq.lastSyncAt).toLocaleString('zh-CN')}`
              : ''}
            {view.qq.lastError ? ` · ${view.qq.lastError}` : ''}
          </p>
          {view.qq.keySaved && (
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ message: string }>('messages/qq/config', {
                    ...qq,
                    key: '',
                  });
                  setNotice(result.message);
                })
              }
            >
              清除 QQ 数据库密钥
            </Button>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveSettings('全局设置已保存');
            }}
          >
            <h3>我的身份</h3>
            <Terms
              label="本人姓名与称呼"
              values={settings.names}
              change={(names) => setSettings((s) => ({ ...s, names }))}
            />
            <Terms
              label="班级名称与简称"
              values={settings.classes}
              change={(classes) => setSettings((s) => ({ ...s, classes }))}
            />
            <Button disabled={busy} className="primary">
              保存全局设置
            </Button>
          </form>
        </>
      ) : tab === 'rules' ? (
        <>
          <h3>会话规则设置</h3>
          <div className="segmented message-rule-kinds">
            <button aria-pressed={ruleKindTab === 'group'} onClick={() => setRuleKindTab('group')}>
              群聊设置（{groupRuleCount}）
            </button>
            <button
              aria-pressed={ruleKindTab === 'private'}
              onClick={() => setRuleKindTab('private')}
            >
              私聊设置（{privateRuleCount}）
            </button>
          </div>
          <p className="hint">
            每条规则独立筛选，多个条件满足任意一项即可。设置默认业务线后直接使用；留空时由 AI
            匹配现有归属，都不匹配时自动预填新项目或业务线名称，可再手动修改。
          </p>
          <div className="message-fields message-rule-toolbar">
            <Button type="button" disabled={busy || !view.qq.configured} onClick={loadGroups}>
              读取 QQ 列表
            </Button>
            <Button
              type="button"
              disabled={settings.rules.length >= 50}
              onClick={() => addRule(ruleKindTab)}
            >
              添加{ruleKindTab === 'group' ? '群聊' : '私聊'}规则
            </Button>
            <Button type="button" disabled={busy} onClick={() => saveSettings('所有规则已保存')}>
              保存所有规则
            </Button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveSettings('所有规则已保存');
            }}
          >
            {!visibleRules.length && (
              <p className="hint">
                {`暂无${ruleKindTab === 'group' ? '群聊' : '私聊'}规则，点击上方“添加${
                  ruleKindTab === 'group' ? '群聊' : '私聊'
                }规则”开始。`}
              </p>
            )}
            {visibleRules.map((rule) => (
              <fieldset key={rule.id} className="message-rule">
                <legend>
                  <span>{rule.name || '新会话'}</span>
                  <button
                    type="button"
                    className="rule-toggle"
                    aria-expanded={!collapsedRules.has(rule.id)}
                    onClick={() => toggleRule(rule.id)}
                  >
                    {collapsedRules.has(rule.id) ? '展开详细' : '收拢详细'}
                  </button>
                </legend>
                <p className="hint">
                  {rule.kind === 'group' ? '群聊' : '私聊'} · {rule.enabled ? '已启用' : '未启用'} ·{' '}
                  {rule.chatId || '未绑定'}
                </p>
                {!collapsedRules.has(rule.id) && (
                  <>
                    <Field label="会话类型">
                      <select
                        value={rule.kind}
                        onChange={(e) => {
                          const kind = e.target.value as 'group' | 'private';
                          setRuleKindTab(kind);
                          updateRule(rule.id, {
                            kind,
                            chatId: null,
                            ...(kind === 'private'
                              ? {
                                  enabled: false,
                                  autoAccept: false,
                                  conditions: rule.conditions.map((condition) =>
                                    condition === 'atAll' ? 'atMe' : condition,
                                  ),
                                }
                              : {}),
                          });
                        }}
                      >
                        <option value="group">群聊</option>
                        <option value="private">个人聊天</option>
                      </select>
                    </Field>
                    {rule.kind === 'group' ? (
                      <QqGroupPicker
                        groups={qqGroups}
                        value={rule.chatId ?? ''}
                        onSelect={(group) => {
                          const previous = qqGroups.find((item) => item.id === rule.chatId);
                          const keepCustomName =
                            Boolean(rule.name.trim()) &&
                            rule.name !== '新会话' &&
                            rule.name !== previous?.name;
                          updateRule(rule.id, {
                            chatId: group?.id ?? null,
                            ...(group && !keepCustomName ? { name: group.name } : {}),
                          });
                        }}
                      />
                    ) : (
                      <>
                        <QqContactPicker
                          contacts={qqContacts}
                          value={rule.chatId ?? ''}
                          onSelect={(contact) => {
                            const previous = qqContacts.find((item) => item.id === rule.chatId);
                            const keepCustomName =
                              Boolean(rule.name.trim()) &&
                              rule.name !== '新会话' &&
                              rule.name !== (previous?.remark || previous?.name);
                            updateRule(rule.id, {
                              chatId: contact?.id ?? null,
                              ...(contact && !keepCustomName
                                ? { name: contact.remark || contact.name }
                                : {}),
                            });
                          }}
                        />
                        <p className="hint">
                          私聊按每条消息独立处理：连续发送多条可能生成多次待确认或重复处理。不建议用于正常聊天，更适合给自己或大小号快速记事项。
                        </p>
                      </>
                    )}
                    <Field label="会话名称">
                      <input
                        required
                        value={rule.name}
                        onChange={(e) => updateRule(rule.id, { name: e.target.value })}
                      />
                    </Field>
                    <label>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
                      />
                      启用此会话
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={activeAi.ready && rule.useAi}
                        disabled={!activeAi.ready}
                        onChange={(e) =>
                          updateRule(rule.id, {
                            useAi: e.target.checked,
                            ...(e.target.checked ? {} : { autoAccept: false }),
                          })
                        }
                      />
                      使用 AI 辅助日程添加
                    </label>
                    {!activeAi.ready && (
                      <p className="hint">
                        需先在“AI 模型”中配置可用的 API 密钥，才可使用 AI 辅助；当前会按未使用 AI
                        处理。
                      </p>
                    )}
                    {activeAi.ready && !rule.useAi && (
                      <p className="hint">
                        关闭后只做规则过滤，消息原样进入待确认，由你设置日期、项目和业务线；可在卡片上再点“用
                        AI 识别”。
                      </p>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={activeAi.ready && rule.autoAccept}
                        disabled={!activeAi.ready || !rule.useAi}
                        onChange={(e) => updateRule(rule.id, { autoAccept: e.target.checked })}
                      />
                      自动加入计划（跳过待确认）
                    </label>
                    {rule.autoAccept && activeAi.ready && rule.useAi && (
                      <p className="hint">
                        命中规则的消息会直接创建节点和待办。建议只给可信的通知群开启。
                      </p>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={rule.includeSelf}
                        onChange={(e) => updateRule(rule.id, { includeSelf: e.target.checked })}
                      />
                      同步本人发送的消息
                    </label>
                    {rule.includeSelf && (
                      <p className="hint">
                        本人发送的消息也会交给 AI
                        检查；即使选择“只检查符合条件的消息”，本人消息也直接检查。
                      </p>
                    )}
                    <Field label="检查范围">
                      <select
                        value={rule.mode}
                        onChange={(e) =>
                          updateRule(rule.id, { mode: e.target.value as 'all' | 'conditions' })
                        }
                      >
                        <option value="all">全部消息交给 AI 检查</option>
                        <option value="conditions">只检查符合条件的消息</option>
                      </select>
                    </Field>
                    {rule.mode === 'conditions' && (
                      <div className="message-conditions">
                        {Object.entries(conditionLabels).map(([condition, label]) => (
                          <label key={condition}>
                            <input
                              type="checkbox"
                              checked={rule.conditions.includes(
                                condition as keyof typeof conditionLabels,
                              )}
                              onChange={(e) =>
                                updateRule(rule.id, {
                                  conditions: e.target.checked
                                    ? [
                                        ...rule.conditions,
                                        condition as keyof typeof conditionLabels,
                                      ]
                                    : rule.conditions.filter((c) => c !== condition),
                                })
                              }
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    )}
                    <Terms
                      label="本会话中的别名"
                      values={rule.aliases}
                      change={(aliases) => updateRule(rule.id, { aliases })}
                    />
                    <Terms
                      label="指定发送人"
                      values={rule.senders}
                      change={(senders) => updateRule(rule.id, { senders })}
                    />
                    <Terms
                      label="关键词"
                      values={rule.keywords}
                      change={(keywords) => updateRule(rule.id, { keywords })}
                    />
                    <ProjectSelect
                      snapshot={snapshot}
                      value={rule.projectId ?? ''}
                      change={(projectId) => {
                        const line = snapshot.entries.find(
                          (e) => e.data.id === rule.lineId && e.data.type === 'workline',
                        );
                        const keepLine =
                          !projectId ||
                          (line?.data.type === 'workline' && line.data.projectId === projectId);
                        updateRule(rule.id, {
                          projectId: projectId || null,
                          lineId: keepLine ? rule.lineId : null,
                        });
                      }}
                    />
                    <LineSelect
                      snapshot={snapshot}
                      projectId={rule.projectId}
                      value={rule.lineId ?? ''}
                      change={(lineId) => updateRule(rule.id, { lineId: lineId || null })}
                    />
                    <p className="hint">
                      只设项目时，AI 只会在该项目下匹配或新建业务线；再设默认业务线则直接使用。
                    </p>
                    <div className="message-fields">
                      <Button
                        type="button"
                        disabled={busy}
                        onClick={() => saveSettings('此规则已保存')}
                      >
                        保存此规则
                      </Button>
                      <Button
                        type="button"
                        onClick={() =>
                          setSettings((s) => ({
                            ...s,
                            rules: s.rules.filter((r) => r.id !== rule.id),
                          }))
                        }
                      >
                        移除此规则
                      </Button>
                    </div>
                  </>
                )}
              </fieldset>
            ))}
          </form>
        </>
      ) : (
        <>
          <details>
            <summary>粘贴 QQ 消息进行识别</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const result = await api<{ message: string }>('messages/analyze', {
                    revision: view.revision,
                    message: {
                      ...source,
                      sentAt: new Date(source.sentAt + '+08:00').toISOString(),
                    },
                  });
                  setNotice(result.message);
                });
              }}
            >
              <p className="hint">
                将命中的消息、补充上下文和身份关键词发送给 {aiLabel}
                。没有默认业务线时，还会发送未结束项目／业务线的名称与标识，用于推荐归属，不发送
                Notes 正文。时间按北京时间填写；@ 标记由你根据原消息确认。
              </p>
              <Field label="来源会话">
                <select
                  required
                  value={source.ruleId}
                  onChange={(e) => setSource({ ...source, ruleId: e.target.value })}
                >
                  <option value="">选择已保存的会话</option>
                  {view.state.settings.rules
                    .filter((r) => r.enabled)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.kind === 'group' ? '群聊' : '私聊'} · {r.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="发送人">
                <input
                  required
                  value={source.sender}
                  onChange={(e) => setSource({ ...source, sender: e.target.value })}
                />
              </Field>
              <Field label="消息发送时间（北京时间）">
                <input
                  required
                  type="datetime-local"
                  value={source.sentAt}
                  onChange={(e) => setSource({ ...source, sentAt: e.target.value })}
                />
              </Field>
              <Field label="消息正文">
                <textarea
                  required
                  rows={5}
                  maxLength={12000}
                  value={source.text}
                  onChange={(e) => setSource({ ...source, text: e.target.value })}
                />
              </Field>
              <div className="message-conditions">
                <label>
                  <input
                    type="checkbox"
                    checked={source.atAll}
                    onChange={(e) => setSource({ ...source, atAll: e.target.checked })}
                  />
                  原消息确实 @全体成员
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={source.atMe}
                    onChange={(e) => setSource({ ...source, atMe: e.target.checked })}
                  />
                  原消息确实 @我
                </label>
              </div>
              <Field label="同一会话的相关上下文（可选）">
                <textarea
                  rows={3}
                  maxLength={6000}
                  value={source.context}
                  onChange={(e) => setSource({ ...source, context: e.target.value })}
                />
              </Field>
              <Button disabled={busy || !activeAi.ready}>
                {busy ? '正在处理…' : `按规则筛选并发送给 ${aiLabel}`}
              </Button>
              {!activeAi.ready && (
                <p className="hint">请先在“模型设置”保存可用的 AI 接口、模型和密钥。</p>
              )}
            </form>
          </details>
          <details className="message-quick">
            <summary>快速处理（本地解析，不调用 AI）</summary>
            <p className="hint">
              粘贴一段文字，先用本地脚本提取日期、时刻、标签和可能业务线，再加入待确认。
            </p>
            <Field label="快速处理会话">
              <select value={quickRuleId} onChange={(e) => setQuickRuleId(e.target.value)}>
                <option value="">选择会话规则</option>
                {view.state.settings.rules
                  .filter((rule) => rule.enabled)
                  .map((rule) => (
                    <option key={rule.id} value={rule.id}>
                      {rule.kind === 'group' ? '群聊' : '私聊'} · {rule.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="快速处理文字">
              <textarea
                rows={3}
                value={quickInput}
                onChange={(e) => {
                  setQuickInput(e.target.value);
                  setQuickParsed(null);
                }}
              />
            </Field>
            <div className="message-bulk-actions">
              <Button
                type="button"
                disabled={busy || !quickInput.trim()}
                onClick={() => setQuickParsed(parseQuickCapture(quickInput, snapshot.entries))}
              >
                本地解析
              </Button>
              <Button
                type="button"
                className="primary"
                disabled={busy || !quickRuleId || !quickInput.trim()}
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ message: string }>('messages/raw', {
                      ruleId: quickRuleId,
                      text: quickInput,
                    });
                    setQuickInput('');
                    setQuickParsed(null);
                    setNotice(result.message);
                  })
                }
              >
                加入待确认
              </Button>
            </div>
            {quickParsed && (
              <p className="hint">
                解析结果：{quickParsed.title}
                {quickParsed.dueDate
                  ? ` · ${quickParsed.dueDate} ${quickParsed.dueTime ?? ''}`
                  : ''}
                {quickParsed.tags.length ? ` · ${quickParsed.tags.join('、')}` : ''}
              </p>
            )}
          </details>
          {!view.state.candidates.length && (
            <p className="hint">暂无待确认事项。先添加会话规则，再粘贴消息验证。</p>
          )}
          {view.state.candidates.length > 0 && (
            <div className="message-bulk-actions">
              <Button disabled={busy} onClick={() => setBulk('accept')}>
                一键确认（{view.state.candidates.length}）
              </Button>
              <Button disabled={busy} onClick={() => setBulk('dismiss')}>
                一键忽略（{view.state.candidates.length}）
              </Button>
            </div>
          )}
          {bulk && (
            <div className="message-bulk-backdrop">
              <div className="message-bulk-confirm" role="alertdialog" aria-modal="true">
                <p>
                  {bulk === 'accept'
                    ? `确定要一键确认全部 ${view.state.candidates.length} 条待确认事项吗？变更会直接修改原事项，取消会标记完成。`
                    : `确定要一键忽略全部 ${view.state.candidates.length} 条待确认事项吗？忽略后原文不会进入计划。`}
                </p>
                <div className="message-bulk-actions">
                  <Button disabled={busy} onClick={() => setBulk(null)}>
                    取消
                  </Button>
                  <Button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await api<{ message: string }>('messages/bulk', {
                          action: bulk,
                          revision: view.revision,
                        });
                        setNotice(result.message);
                        setBulk(null);
                      })
                    }
                  >
                    确定
                  </Button>
                </div>
              </div>
            </div>
          )}
          {view.state.candidates.map((candidate) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              snapshot={snapshot}
              busy={busy}
              canUseAi={activeAi.ready}
              accept={(lineId, suggestion, projectId) =>
                void run(async () => {
                  await api('messages/accept', {
                    id: candidate.id,
                    revision: view.revision,
                    lineId,
                    projectId: projectId ?? null,
                    suggestion,
                  });
                  await reload();
                  setNotice(
                    suggestion.kind === 'change'
                      ? suggestion.completed
                        ? '已标记为完成'
                        : '已按建议修改原事项'
                      : suggestion.kind === 'cancel'
                        ? '已取消原事项（标记完成）'
                        : '已加入计划，原文已保存到业务线 Notes',
                  );
                })
              }
              recognize={() =>
                void run(async () => {
                  const result = await api<{ message: string }>('messages/recognize', {
                    id: candidate.id,
                    revision: view.revision,
                  });
                  setNotice(result.message);
                })
              }
              dismiss={() =>
                void run(async () => {
                  await api('messages/dismiss', { id: candidate.id, revision: view.revision });
                  setNotice('已关闭此事项');
                })
              }
            />
          ))}
        </>
      )}
      <Button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setNotice('已重新加载已保存的规则与事项');
          })
        }
      >
        重新加载 QQ 同步
      </Button>
    </section>
  );
}
