import { useState } from 'react';
import type { Entry } from '../../../../../packages/domain/index';
import { save } from '../../api';
import { Button, DatePicker, ErrorMessage, Field, Modal } from '../../components/ui';

export function MobileSchedule({
  entry,
  reload,
  close,
}: {
  entry: Entry;
  reload: () => Promise<void>;
  close: () => void;
}) {
  const [original] = useState(entry);
  const item = original.data;
  const [dueDate, setDate] = useState(
    item.type === 'milestone' || item.type === 'todo' ? (item.dueDate ?? '') : '',
  );
  const [dueTime, setTime] = useState(item.type === 'milestone' ? (item.dueTime ?? '') : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (item.type !== 'milestone' && item.type !== 'todo') return null;
  return (
    <Modal title="调整时间" className="mobile-schedule-dialog" onClose={() => !busy && close()}>
      <form
        inert={busy}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            await save(
              {
                ...item,
                dueDate: dueDate || null,
                ...(item.type === 'milestone' ? { dueTime: dueTime || null } : {}),
              },
              original,
            );
            await reload();
            close();
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="mobile-schedule-fields">
          <Field label="日期">
            <DatePicker
              value={dueDate}
              required={Boolean(dueTime)}
              onChange={(event) => {
                setDate(event.target.value);
                if (!event.target.value) setTime('');
              }}
            />
          </Field>
          {item.type === 'milestone' && (
            <Field label="时刻">
              <input
                type="time"
                value={dueTime}
                onChange={(event) => setTime(event.target.value)}
              />
            </Field>
          )}
        </div>
        <ErrorMessage message={error} />
        <div className="form-actions">
          <Button
            type="button"
            onClick={() => {
              setDate('');
              setTime('');
            }}
          >
            未定
          </Button>
          <Button type="submit" className="primary" disabled={busy}>
            {busy ? '正在保存…' : '保存'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
