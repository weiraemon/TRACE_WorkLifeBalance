import { useState } from 'react';
import { localDay, type Snapshot } from '../../../../packages/domain/index';
import { overdueTodos, todoDate } from '../../../../packages/domain/workspace';
import { createRecord, removeSpace, save } from '../api';
import { Button, Modal, ErrorMessage } from '../components/ui';

export function OverdueTodos({
  snapshot,
  date,
  reload,
}: {
  snapshot: Snapshot;
  date: string;
  reload: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const today = localDay();
  const overdue = overdueTodos(snapshot.entries, today);
  if (date !== today || (!overdue.length && !open)) return null;
  const process = async (action: 'move' | 'delete') => {
    setBusy(true);
    setError('');
    let done = 0;
    try {
      for (const { todo } of overdue) {
        const entry = snapshot.entries.find((e) => e.data.id === todo.id)!;
        if (action === 'move') await save(createRecord('todo', { ...todo, dueDate: today }), entry);
        else await removeSpace(entry);
        done++;
      }
      setOpen(false);
    } catch (e) {
      setError(`已处理 ${done} 项。${e instanceof Error ? e.message : String(e)}`);
    } finally {
      try {
        await reload();
      } catch (e) {
        setOpen(true);
        setError(`已处理 ${done} 项，但刷新失败：${String(e)}`);
      }
      setBusy(false);
    }
  };
  return (
    <>
      {overdue.length > 0 && (
        <div className="overdue-prompt" role="status">
          <span>{overdue.length} 项待办已过期</span>
          <Button
            onClick={() => {
              setError('');
              setOpen(true);
            }}
          >
            处理
          </Button>
        </div>
      )}
      {open && (
        <Modal
          title="处理逾期待办"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <p className="hint">统一顺延到今天；超过原节点日期的移入原业务线待办池。批注保留。</p>
          <ul className="overdue-list">
            {overdue.map((c) => (
              <li key={c.todo.id}>
                <span>{c.todo.title}</span>
                <small>
                  {c.project.title} / {c.line.title} · {todoDate(c)}
                </small>
              </li>
            ))}
          </ul>
          <ErrorMessage message={error} />
          <div className="form-actions">
            <Button
              className="danger"
              disabled={busy || !overdue.length}
              onClick={() => void process('delete')}
            >
              全部删除
            </Button>
            <Button disabled={busy} onClick={() => setOpen(false)}>
              暂不处理
            </Button>
            <Button
              className="primary"
              disabled={busy || !overdue.length}
              onClick={() => void process('move')}
            >
              全部挪到今天
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
