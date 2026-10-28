import { useState } from 'react';
import { localDay, type Snapshot } from '../../../../packages/domain/index';
import { overdueMilestones } from '../../../../packages/domain/workspace';
import { createRecord, removeSpace, save } from '../api';
import { Button, DatePicker, ErrorMessage, Modal } from '../components/ui';

export function OverdueEvents({
  snapshot,
  date,
  reload,
}: {
  snapshot: Snapshot;
  date: string;
  reload: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const today = localDay();
  const overdue = overdueMilestones(snapshot.entries, today);
  if (date !== today) return null;

  const update = async (id: string, targetDate: string | null) => {
    const context = overdue.find(({ milestone }) => milestone.id === id);
    const entry = snapshot.entries.find(({ data }) => data.id === id);
    if (!context || !entry) return;
    setBusyId(id);
    setError('');
    try {
      if (targetDate === null) await removeSpace(entry);
      else
        await save(createRecord('milestone', { ...context.milestone, dueDate: targetDate }), entry);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId('');
    }
  };

  const addDays = (days: number) => {
    const target = new Date(`${today}T12:00:00`);
    target.setDate(target.getDate() + days);
    return localDay(target);
  };

  return (
    <>
      <div className="overdue-prompt" role="status">
        <span>过期事件 · {overdue.length}</span>
        <Button onClick={() => setOpen(true)}>查看</Button>
      </div>
      {open && (
        <Modal title="过期事件" onClose={() => !busyId && setOpen(false)} wide>
          {!overdue.length ? (
            <p className="hint">没有过期事件。</p>
          ) : (
            <ul className="overdue-event-list">
              {overdue.map(({ milestone, line }) => (
                <li key={milestone.id}>
                  <div className="overdue-event-name">
                    <strong>{milestone.title}</strong>
                    <small>
                      {line.title} · {milestone.dueDate}
                    </small>
                  </div>
                  <div className="overdue-event-actions">
                    <Button
                      className="danger"
                      disabled={Boolean(busyId)}
                      onClick={() => void update(milestone.id, null)}
                    >
                      删除
                    </Button>
                    <Button
                      disabled={Boolean(busyId)}
                      onClick={() => void update(milestone.id, today)}
                    >
                      今日
                    </Button>
                    <Button
                      disabled={Boolean(busyId)}
                      onClick={() => void update(milestone.id, addDays(1))}
                    >
                      明日
                    </Button>
                    <Button
                      disabled={Boolean(busyId)}
                      onClick={() => void update(milestone.id, addDays(7))}
                    >
                      下周
                    </Button>
                    <DatePicker
                      aria-label={`自选日期 · ${milestone.title}`}
                      title="自选日期"
                      disabled={Boolean(busyId)}
                      onChange={(event) =>
                        event.target.value && void update(milestone.id, event.target.value)
                      }
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <ErrorMessage message={error} />
        </Modal>
      )}
    </>
  );
}
