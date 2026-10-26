import { useState } from 'react';
import { type Snapshot, type Todo, type Milestone } from '../../../../packages/domain/index';
import { activeLines } from '../../../../packages/domain/workspace';
import { createRecord } from '../api';
import { Button, Field, ErrorMessage } from '../components/ui';
import { ImportancePicker } from '../components/Importance';
export function QuickCapture({
  snapshot,
  onCreate,
  defaultLineId = '',
}: {
  snapshot: Snapshot;
  onCreate: (item: Todo, comment: string) => Promise<void>;
  defaultLineId?: string;
}) {
  const [importance, setImportance] = useState(1);
  const [title, setTitle] = useState(''),
    [kind, setKind] = useState<'todo' | 'idea'>('idea');
  const [lineId, setLineId] = useState(defaultLineId),
    [nodeId, setNodeId] = useState('');
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
  const submit = async () => {
    if (busy) return;
    if (!title.trim()) {
      setError('先写下要做什么');
      return;
    }
    if (!lineId || !chosen) {
      setError('请选择业务线');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onCreate(
        createRecord('todo', { id, title, kind, importance, milestoneId: chosen }) as Todo,
        comment,
      );
      setTitle('');
      setImportance(1);
      setComment('');
      setId(crypto.randomUUID());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="quick-capture" aria-label="快速创建 TODO / IDEA">
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
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
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
      </div>
      <fieldset className="primary-settings">
        <legend>重要性</legend>
        <ImportancePicker value={importance} onChange={setImportance} />
      </fieldset>
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
