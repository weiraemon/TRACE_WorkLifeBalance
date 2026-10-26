import { useState } from 'react';
import { type Snapshot, type Todo, type Milestone } from '../../../../packages/domain/index';
import { activeLines } from '../../../../packages/domain/workspace';
import { createRecord } from '../api';
import { Button, Field, ErrorMessage } from '../components/ui';
import { ImportancePicker } from '../components/Importance';
import { parseQuickCapture } from './quickCaptureParser';
export function QuickCapture({
  snapshot,
  onCreate,
  defaultLineId = '',
  allowMilestone = true,
  today,
}: {
  snapshot: Snapshot;
  onCreate: (item: Todo | Milestone, comment: string) => Promise<void>;
  defaultLineId?: string;
  allowMilestone?: boolean;
  today?: string;
}) {
  const [importance, setImportance] = useState(1);
  const [title, setTitle] = useState(''),
    [captureType, setCaptureType] = useState<'milestone' | 'todo' | 'idea'>('idea');
  const [lineId, setLineId] = useState(defaultLineId),
    [nodeId, setNodeId] = useState('');
  const [dueDate, setDueDate] = useState(''),
    [dueTime, setDueTime] = useState(''),
    [tags, setTags] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [comment, setComment] = useState(''),
    [id, setId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const projectTitles = new Map(
    snapshot.entries.flatMap((e) =>
      e.data.type === 'project' ? [[e.data.id, e.data.title] as const] : [],
    ),
  );
  const lines = activeLines(snapshot.entries);
  const nodes = snapshot.entries
    .map((e) => e.data)
    .filter((r): r is Milestone => r.type === 'milestone' && r.lineId === lineId);
  const chosen = nodeId || nodes.find((r) => r.pool)?.id || '';
  const applyParsedText = (value: string) => {
    const parsed = parseQuickCapture(value, snapshot.entries, today);
    setTitle(parsed.title);
    setCaptureType(allowMilestone ? 'milestone' : 'idea');
    setImportance(parsed.importance);
    setLineId(parsed.lineId);
    setNodeId('');
    setDueDate(parsed.dueDate ?? '');
    setDueTime(parsed.dueTime ?? '');
    setTags(parsed.tags.join('，'));
    setError('');
  };
  const parseText = () => applyParsedText(sourceText);
  const submit = async () => {
    if (busy) return;
    if (!title.trim()) {
      setError('先写下要做什么');
      return;
    }
    if (!lineId || (captureType !== 'milestone' && !chosen)) {
      setError('请选择业务线');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const item =
        captureType === 'milestone'
          ? (createRecord('milestone', {
              id,
              title,
              importance,
              lineId,
              dueDate: dueDate || null,
              dueTime: dueDate ? dueTime || null : null,
              tags: [
                ...new Set(
                  tags
                    .split(/[,，]/)
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                ),
              ],
            }) as Milestone)
          : (createRecord('todo', {
              id,
              title,
              kind: captureType,
              importance,
              milestoneId: chosen,
              dueDate: dueDate || null,
            }) as Todo);
      await onCreate(item, comment);
      setTitle('');
      setImportance(1);
      setComment('');
      setSourceText('');
      setDueDate('');
      setDueTime('');
      setTags('');
      setId(crypto.randomUUID());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="quick-capture" aria-label="快速创建 TODO / IDEA">
      <div className="quick-capture-paste">
        <Field label="粘贴微信消息" wide>
          <textarea
            rows={3}
            value={sourceText}
            placeholder="例如：明天上午九点半所里一块讨论下推进方案"
            onChange={(e) => setSourceText(e.target.value)}
            onPaste={(e) => {
              const value = e.clipboardData.getData('text');
              if (!value.trim()) return;
              e.preventDefault();
              setSourceText(value);
              applyParsedText(value);
            }}
          />
        </Field>
        <Button type="button" onClick={parseText} disabled={!sourceText.trim()}>
          识别时间和节点
        </Button>
        {sourceText && (
          <p className="hint quick-capture-result">
            会识别“明天 / 周二 / 下周二”、9点 / 九点 /
            9.、上午下午和半点；识别不到业务线时请手动选择。
          </p>
        )}
      </div>
      <Field label="要做什么">
        <input
          value={title}
          placeholder="写下下一步或新想法…"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </Field>
      <div className="quick-capture-controls">
        <Field label="类型">
          <select
            value={captureType}
            onChange={(e) => setCaptureType(e.target.value as typeof captureType)}
          >
            {allowMilestone && <option value="milestone">节点</option>}
            <option value="idea">IDEA</option>
            <option value="todo">TODO</option>
          </select>
        </Field>
        <Field label="业务线">
          <select
            value={lineId}
            onChange={(e) => {
              setLineId(e.target.value);
              setNodeId('');
            }}
          >
            <option value="">选择业务线</option>
            {lines.map((r) => (
              <option value={r.id} key={r.id}>
                {projectTitles.get(r.projectId)} / {r.title}
              </option>
            ))}
          </select>
        </Field>
        {captureType !== 'milestone' && (
          <Field label="具体节点">
            <select value={chosen} disabled={!lineId} onChange={(e) => setNodeId(e.target.value)}>
              {!chosen && <option value="">先选择业务线</option>}
              {nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.title}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <fieldset className="primary-settings">
        <legend>重要性</legend>
        <ImportancePicker value={importance} onChange={setImportance} />
      </fieldset>
      {allowMilestone && captureType === 'milestone' && (
        <div className="quick-capture-controls">
          <Field label="截止日期">
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="截止时刻">
            <input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
          </Field>
          <Field label="节点标签">
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="会议，讨论…"
            />
          </Field>
        </div>
      )}
      <div className="quick-capture-extra">
        <Field label="批注">
          <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </div>
      <ErrorMessage message={error} />
      <div className="form-actions">
        <Button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '正在保存…' : '添加'}
        </Button>
      </div>
    </section>
  );
}
