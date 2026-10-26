import { useState } from 'react';
import {
  clock,
  localDay,
  type Snapshot,
  type Todo,
  type Milestone,
} from '../../../../packages/domain/index';
import {
  activeLines,
  compareMilestones,
  todoContexts,
} from '../../../../packages/domain/workspace';
import { createRecord, save } from '../api';
import { Modal, Field, Button, ErrorMessage, DatePicker } from '../components/ui';
import type { Editor } from './editor';
import { QuickCapture } from './QuickCapture';
export function ActualRecordForm({
  editor,
  snapshot,
  close,
  reload,
  embedded = false,
}: {
  editor: Editor;
  snapshot: Snapshot;
  close: () => void;
  reload: () => Promise<void>;
  embedded?: boolean;
}) {
  const old = editor.entry?.data.type === 'actual' ? editor.entry.data : undefined;
  const now = new Date(),
    minute = Math.min(1439, now.getHours() * 60 + now.getMinutes());
  const [id] = useState(() => old?.id ?? crypto.randomUUID());
  const [startTime, setStart] = useState(
    old?.startTime ?? String(editor.defaults?.startTime ?? clock(Math.max(0, minute - 30))),
  );
  const [endTime, setEnd] = useState(
    old?.endTime ?? String(editor.defaults?.endTime ?? clock(minute || 1)),
  );
  const [description, setDescription] = useState(old?.description ?? '');
  const [date, setDate] = useState(old?.date ?? String(editor.defaults?.date ?? localDay()));
  const [milestoneIds, setMilestoneIds] = useState<string[]>(old?.milestoneIds ?? []);
  const [nodeId, setNodeId] = useState('');
  const [linked, setLinked] = useState<string[]>(old?.itemIds ?? []);
  const [completed, setCompleted] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Todo[]>([]);
  const [comments, setComments] = useState<Record<string, { id: string; text: string }>>({});
  const [lineId, setLineId] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const virtual = [
    ...snapshot.entries,
    ...drafts.map((data) => ({ data, path: '', revision: '' })),
  ];
  const contexts = todoContexts(virtual).filter(
    (c) =>
      linked.includes(c.todo.id) ||
      (!c.todo.completedAt && !c.line.completedAt && !c.project.completedAt),
  );
  const selected = contexts.filter((c) => linked.includes(c.todo.id));
  const lines = activeLines(snapshot.entries);
  const nodes = snapshot.entries
    .map((e) => e.data)
    .filter((r): r is Milestone => r.type === 'milestone' && !r.pool);
  const selectedNodes = nodes.filter((node) => milestoneIds.includes(node.id));
  const commentField = (targetId: string, title: string) => (
    <Field label={`批注 · ${title}`}>
      <textarea
        rows={2}
        value={comments[targetId]?.text ?? ''}
        onChange={(e) =>
          setComments((values) => ({
            ...values,
            [targetId]: { id: values[targetId]?.id ?? crypto.randomUUID(), text: e.target.value },
          }))
        }
      />
    </Field>
  );
  const form = (
    <form
      aria-label="实际工作录入"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await save(
            createRecord('actual', {
              ...(old ?? {}),
              id,
              date,
              startTime,
              endTime,
              description,
              itemIds: linked,
              milestoneIds,
            }),
            editor.entry,
            {
              newItems: drafts.filter((r) => linked.includes(r.id)),
              completeIds: completed.filter((target) => linked.includes(target)),
              comments: Object.entries(comments)
                .filter(
                  ([target, value]) =>
                    (linked.includes(target) || milestoneIds.includes(target)) && value.text.trim(),
                )
                .map(([targetId, value]) => ({ ...value, targetId, date })),
            },
          );
          await reload();
          close();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="具体事件">
        <textarea
          required
          autoFocus={!embedded}
          rows={2}
          placeholder="写下这段时间具体做了什么…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="actual-time-fields">
        <Field label="记录日期">
          <DatePicker value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </Field>
        <Field label="开始时间">
          <input
            type="time"
            required
            value={startTime}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="结束时间">
          <input
            required
            pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00"
            value={endTime}
            onChange={(e) => setEnd(e.target.value)}
          />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="先选择业务线">
          <select
            value={lineId}
            onChange={(e) => {
              setLineId(e.target.value);
              setNodeId('');
            }}
          >
            <option value="">选择业务线（可选）</option>
            {lines.map((line) => (
              <option key={line.id} value={line.id}>
                {line.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="关联节点">
          <select
            value={nodeId}
            disabled={!lineId}
            onChange={(e) => {
              const value = e.target.value;
              setNodeId(value);
              if (value) setMilestoneIds((ids) => (ids.includes(value) ? ids : [...ids, value]));
            }}
          >
            <option value="">{lineId ? '选择节点（可选）' : '先选择业务线'}</option>
            {nodes
              .filter((node) => node.lineId === lineId)
              .sort(compareMilestones)
              .map((node) => (
                <option key={node.id} value={node.id}>
                  {node.title}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <section className="linked-nodes" aria-label="已关联节点">
        {selectedNodes.map((node) => (
          <div className="actual-item" key={node.id}>
            <label className="check-label">
              <input
                type="checkbox"
                checked
                aria-label={`关联节点 ${node.title}`}
                onChange={() => {
                  setMilestoneIds((ids) => ids.filter((id) => id !== node.id));
                  if (nodeId === node.id) setNodeId('');
                }}
              />
              {node.title}
            </label>
            {commentField(node.id, node.title)}
          </div>
        ))}
      </section>
      <section className="actual-associations" aria-label="关联 TODO / IDEA">
        <section className="linked-todos" aria-label="已关联条目">
          {selected.map((c) => (
            <div className="actual-item" key={c.todo.id} data-space-id={c.todo.id}>
              <div className="actual-todo-choice">
                <label>
                  <input
                    type="checkbox"
                    checked
                    aria-label={`关联 ${c.todo.title}`}
                    onChange={() => {
                      setLinked((ids) => ids.filter((target) => target !== c.todo.id));
                      setCompleted((ids) => ids.filter((target) => target !== c.todo.id));
                    }}
                  />
                  <span>
                    {c.todo.kind.toUpperCase()} · {c.todo.title}
                    <small>
                      {c.project.title} / {c.line.title}
                    </small>
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(c.todo.completedAt) || completed.includes(c.todo.id)}
                    disabled={Boolean(c.todo.completedAt)}
                    aria-label={`本次完成 ${c.todo.title}`}
                    onChange={(e) =>
                      setCompleted((ids) =>
                        e.target.checked
                          ? [...ids, c.todo.id]
                          : ids.filter((target) => target !== c.todo.id),
                      )
                    }
                  />
                  本次完成
                </label>
              </div>
              {commentField(c.todo.id, c.todo.title)}
            </div>
          ))}
        </section>
        <div className="completion-picker">
          {contexts
            .filter(
              (c) =>
                c.line.id === lineId &&
                (!nodeId || c.milestone.id === nodeId) &&
                !linked.includes(c.todo.id),
            )
            .map((c) => (
              <label className="actual-todo-choice" key={c.todo.id}>
                <input
                  type="checkbox"
                  checked={false}
                  aria-label={`关联 ${c.todo.title}`}
                  onChange={() => setLinked((ids) => [...ids, c.todo.id])}
                />
                {c.todo.kind.toUpperCase()} · {c.todo.title}
              </label>
            ))}
        </div>
      </section>
      <ErrorMessage message={error} />
      <div className="form-actions">
        <Button type="button" onClick={close}>
          {embedded ? '清空' : '取消'}
        </Button>
        <Button type="submit" className="primary" disabled={busy}>
          {busy ? '正在保存…' : '保存实际工作'}
        </Button>
      </div>
      <section className="actual-new-items" aria-label="本次产生 TODO / IDEA">
        <h3>本次产生 TODO / IDEA</h3>
        <QuickCapture
          snapshot={snapshot}
          key={lineId}
          defaultLineId={lineId}
          onCreate={async (item, comment) => {
            setDrafts((items) => [...items, item]);
            setLinked((ids) => [...ids, item.id]);
            if (comment.trim())
              setComments((values) => ({
                ...values,
                [item.id]: { id: crypto.randomUUID(), text: comment },
              }));
          }}
        />
      </section>
    </form>
  );
  return embedded ? (
    form
  ) : (
    <Modal title={`${old ? '编辑' : '记录'}实际工作 · ${date}`} onClose={close}>
      {form}
    </Modal>
  );
}
