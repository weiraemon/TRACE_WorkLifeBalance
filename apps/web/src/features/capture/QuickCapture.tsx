import { useRef, useState } from 'react';
import { type Snapshot, type Todo, type Milestone } from '../../../../../packages/domain/index';
import { activeLines } from '../../../../../packages/domain/workspace';
import { createRecord } from '../../api';
import { Button, Field, ErrorMessage } from '../../components/ui';
import { ImportancePicker } from '../../components/Importance';
import { useDraftState, useDraftSaving, clearDraft } from '../drafts/useDraftState';
import { parseQuickCapture } from './quickCaptureParser';
export function QuickCapture({
  snapshot,
  onCreate,
  today,
}: {
  snapshot: Snapshot;
  onCreate: (item: Todo | Milestone, comment: string) => Promise<void>;
  today: string;
}) {
  const draftKey = `${snapshot.root}:quick-capture`;
  const [importance, setImportance] = useDraftState(draftKey + ':importance', 1);
  const [title, setTitle] = useDraftState(draftKey + ':title', ''),
    [captureType, setCaptureType] = useDraftState<'milestone' | 'todo' | 'idea'>(
      draftKey + ':captureType',
      'todo',
    );
  const [lineId, setLineId] = useDraftState(draftKey + ':lineId', ''),
    [nodeId, setNodeId] = useDraftState(draftKey + ':nodeId', '');
  const [dueDate, setDueDate] = useDraftState(draftKey + ':dueDate', ''),
    [dueTime, setDueTime] = useDraftState(draftKey + ':dueTime', ''),
    [tags, setTags] = useDraftState(draftKey + ':tags', '');
  const [sourceText, setSourceText] = useDraftState(draftKey + ':sourceText', '');
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const [comment, setComment] = useDraftState(draftKey + ':comment', ''),
    [id, setId] = useDraftState(draftKey + ':id', () => crypto.randomUUID());
  const [busy, setBusy] = useDraftSaving(draftKey),
    [error, setError] = useState('');
  const lines = activeLines(snapshot.entries);
  const nodes = snapshot.entries
    .map((e) => e.data)
    .filter((r): r is Milestone => r.type === 'milestone' && r.lineId === lineId);
  const chosen = nodeId || nodes.find((r) => r.pool)?.id || '';
  const applyParsedText = (value: string) => {
    const parsed = parseQuickCapture(value, snapshot.entries, today);
    setTitle(parsed.title);
    setCaptureType('milestone');
    setImportance(parsed.importance);
    if (!lineId && parsed.lineId) {
      setLineId(parsed.lineId);
      setNodeId('');
    }
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
              dueDate: dueDate || today,
              dueTime: dueTime || null,
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
              dueDate: dueDate || (captureType === 'todo' ? today : null),
            }) as Todo);
      await onCreate(item, comment);
      clearDraft(draftKey);
      setLineId(lineId);
      setNodeId(chosen);
      setCaptureType(captureType);
      setTitle('');
      setImportance(1);
      setComment('');
      setSourceText('');
      setDueDate('');
      setDueTime('');
      setTags('');
      setId(crypto.randomUUID());
      sourceInput.current?.focus({ preventScroll: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const pasteCapture = (
    <div className="quick-capture-paste">
      <div className="field span-two">
        <textarea
          ref={sourceInput}
          aria-label="粘贴微信消息"
          rows={3}
          value={sourceText}
          placeholder="粘贴消息…"
          onChange={(e) => setSourceText(e.target.value)}
          onPaste={(e) => {
            const value = e.clipboardData.getData('text');
            if (!value.trim()) return;
            e.preventDefault();
            setSourceText(value);
            applyParsedText(value);
          }}
        />
      </div>
      <Button type="button" onClick={parseText} disabled={!sourceText.trim()}>
        识别时间和节点
      </Button>
    </div>
  );
  return (
    <section
      inert={busy}
      className="quick-capture compact-capture"
      aria-label="快速创建 TODO / IDEA"
    >
      <h2 className="capture-recognition-heading">自动匹配与识别</h2>
      {pasteCapture}
      <div className="quick-capture-controls">
        <select
          className="line-dropdown"
          aria-label="业务线"
          value={lineId}
          onChange={(event) => {
            setLineId(event.target.value);
            setNodeId('');
          }}
        >
          <option value="">选择业务线</option>
          {lines.map((line) => (
            <option key={line.id} value={line.id}>
              {line.title}
            </option>
          ))}
        </select>
        <select
          className="line-dropdown"
          aria-label="类型"
          value={captureType}
          onChange={(event) => setCaptureType(event.target.value as typeof captureType)}
        >
          <option value="todo">TODO</option>
          <option value="idea">IDEA</option>
          <option value="milestone">节点</option>
        </select>
      </div>
      <Field label="要做什么">
        <input
          value={title}
          placeholder="写下下一步…"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </Field>
      {captureType !== 'milestone' && (
        <Field label="具体节点">
          <select
            value={chosen}
            disabled={!lineId}
            onChange={(event) => setNodeId(event.target.value)}
          >
            {!chosen && <option value="">先选择业务线</option>}
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.title}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="quick-capture-controls">
        <Field label={captureType === 'milestone' ? '截止日期' : '条目日期'}>
          <input
            type="date"
            value={dueDate || (captureType !== 'idea' ? (today ?? '') : '')}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </Field>
        {captureType === 'milestone' && (
          <Field label="截止时刻">
            <input
              type="time"
              value={dueTime}
              onChange={(event) => setDueTime(event.target.value)}
            />
          </Field>
        )}
      </div>
      {captureType === 'milestone' && (
        <Field label="节点标签">
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="会议，讨论…"
          />
        </Field>
      )}
      <fieldset className="primary-settings">
        <legend>重要性</legend>
        <ImportancePicker value={importance} onChange={setImportance} />
      </fieldset>
      <Field label="批注">
        <textarea rows={2} value={comment} onChange={(event) => setComment(event.target.value)} />
      </Field>
      <ErrorMessage message={error} />
      <div className="form-actions">
        <Button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '正在保存…' : '添加'}
        </Button>
      </div>
    </section>
  );
}
