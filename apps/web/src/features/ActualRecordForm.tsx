import { useState } from 'react';
import { clock, localDay, actualTodoIds, type Snapshot } from '../../../../packages/domain/index';
import { todoContexts } from '../../../../packages/domain/workspace';
import { createRecord, save } from '../api';
import { Modal, Field, Button, ErrorMessage, DatePicker } from '../components/ui';
import type { Editor } from './editor';
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
  const now = new Date();
  const minute = Math.min(1439, now.getHours() * 60 + now.getMinutes());
  const [startTime, setStart] = useState(
    old?.startTime ?? String(editor.defaults?.startTime ?? clock(Math.max(0, minute - 30))),
  );
  const [endTime, setEnd] = useState(
    old?.endTime ?? String(editor.defaults?.endTime ?? clock(minute || 1)),
  );
  const [description, setDescription] = useState(
    old?.description ?? String(editor.defaults?.description ?? ''),
  );
  const [date, setDate] = useState(old?.date ?? String(editor.defaults?.date ?? localDay()));
  const [linked, setLinked] = useState<string[]>(() => (old ? actualTodoIds(old) : []));
  const [completed, setCompleted] = useState<string[]>(old?.completedTodoIds ?? []);
  const [query, setQuery] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const contexts = todoContexts(snapshot.entries).filter(
    (c) => linked.includes(c.todo.id) || c.todo.status !== 'Cancelled',
  );
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
                date,
                startTime,
                endTime,
                description,
                workedTodoIds: linked.filter((id) => !completed.includes(id)),
                completedTodoIds: completed,
              }),
              editor.entry,
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
              step="60"
              required
              value={startTime}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          <Field label="结束时间">
            <input
              required
              value={endTime}
              pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00"
              placeholder="18:30"
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
            placeholder="这段时间实际做了什么？"
          />
        </Field>
        <details className="optional-settings" open={linked.length ? true : undefined}>
          <summary>关联待办（可选）{linked.length ? ` · ${linked.length} 项` : ''}</summary>
          <Field label="查找待办">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索事件、联系人或项目"
            />
          </Field>
          <div className="completion-picker">
            {contexts
              .filter((c) => `${c.todo.title} ${c.todo.person} ${c.project.title}`.includes(query))
              .map((c) => (
                <div className="actual-todo-choice" key={c.todo.id}>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`关联 ${c.todo.title}`}
                      checked={linked.includes(c.todo.id)}
                      onChange={(e) => {
                        setLinked((ids) =>
                          e.target.checked
                            ? [...ids, c.todo.id]
                            : ids.filter((id) => id !== c.todo.id),
                        );
                        if (!e.target.checked)
                          setCompleted((ids) => ids.filter((id) => id !== c.todo.id));
                      }}
                    />
                    <span>
                      {c.todo.title}
                      <small>
                        {c.project.title} / {c.milestone.title}
                      </small>
                    </span>
                  </label>
                  {linked.includes(c.todo.id) && (
                    <label className="completion-toggle">
                      <input
                        type="checkbox"
                        aria-label={`本次完成 ${c.todo.title}`}
                        checked={completed.includes(c.todo.id)}
                        disabled={snapshot.entries.some(
                          (e) =>
                            e.data.type === 'actual' &&
                            e.data.id !== old?.id &&
                            e.data.completedTodoIds.includes(c.todo.id),
                        )}
                        onChange={(e) =>
                          setCompleted((ids) =>
                            e.target.checked
                              ? [...ids, c.todo.id]
                              : ids.filter((id) => id !== c.todo.id),
                          )
                        }
                      />
                      本次完成
                    </label>
                  )}
                </div>
              ))}
            {!contexts.length && <p className="hint">尚无待办也可以直接记录实际工作。</p>}
          </div>
        </details>
        <details className="optional-settings">
          <summary>调整记录日期 / 查看历史</summary>
          <Field label="记录日期">
            <DatePicker value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </Field>
          {old?.history.map((h, i) => (
            <p className="hint" key={i}>
              {h.date} {h.startTime}–{h.endTime} · {h.description}
            </p>
          ))}
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
