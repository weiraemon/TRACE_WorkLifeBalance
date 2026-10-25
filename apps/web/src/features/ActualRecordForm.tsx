import { useState } from 'react';
import {
  clock,
  localDay,
  type Snapshot,
  type Todo,
  type BusinessLine,
} from '../../../../packages/domain/index';
import { todoContexts } from '../../../../packages/domain/workspace';
import { createRecord, save } from '../api';
import { Modal, Field, Button, ErrorMessage, DatePicker } from '../components/ui';
import type { Editor } from './editor';
import { QuickCapture } from './QuickCapture';
export function ActualRecordForm({
  editor,
  snapshot,
  close,
  reload,
}: {
  editor: Editor;
  snapshot: Snapshot;
  close: () => void;
  reload: () => Promise<void>;
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
  const lines = snapshot.entries
    .map((e) => e.data)
    .filter((r): r is BusinessLine => r.type === 'workline' && !r.completedAt);
  return (
    <Modal title={`${old ? '编辑' : '记录'}实际工作 · ${date}`} onClose={close}>
      <form
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
              }),
              editor.entry,
              {
                newItems: drafts.filter((r) => linked.includes(r.id)),
                completeIds: completed.filter((target) => linked.includes(target)),
                comments: Object.entries(comments)
                  .filter(([target, value]) => linked.includes(target) && value.text.trim())
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
        <div className="form-grid">
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
        <Field label="具体事件">
          <textarea
            required
            autoFocus
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <details className="optional-settings" open={linked.length ? true : undefined}>
          <summary>关联 TODO / IDEA</summary>
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
                <Field label={`批注 · ${c.todo.title}`}>
                  <textarea
                    rows={2}
                    value={comments[c.todo.id]?.text ?? ''}
                    onChange={(e) =>
                      setComments((values) => ({
                        ...values,
                        [c.todo.id]: {
                          id: values[c.todo.id]?.id ?? crypto.randomUUID(),
                          text: e.target.value,
                        },
                      }))
                    }
                  />
                </Field>
              </div>
            ))}
          </section>
          <Field label="先选择业务线">
            <select value={lineId} onChange={(e) => setLineId(e.target.value)}>
              <option value="">选择业务线</option>
              {lines.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.title}
                </option>
              ))}
            </select>
          </Field>
          <div className="completion-picker">
            {contexts
              .filter((c) => c.line.id === lineId && !linked.includes(c.todo.id))
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
        </details>
        <details className="optional-settings">
          <summary>新建 TODO / IDEA</summary>
          <QuickCapture
            snapshot={snapshot}
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
        </details>
        <details className="optional-settings">
          <summary>调整记录日期</summary>
          <Field label="记录日期">
            <DatePicker value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </Field>
        </details>
        <ErrorMessage message={error} />
        <div className="form-actions">
          <Button type="button" onClick={close}>
            取消
          </Button>
          <Button type="submit" className="primary" disabled={busy}>
            {busy ? '正在保存…' : '保存实际工作'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
