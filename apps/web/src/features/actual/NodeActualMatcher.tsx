import { useState } from 'react';
import { localDay, type Entry, type Snapshot } from '../../../../../packages/domain/index';
import { save } from '../../api';
import { Button, DatePicker, ErrorMessage, Modal } from '../../components/ui';
import { actualsForDay } from './selectors';

export function NodeActualMatcher({
  entry,
  snapshot,
  reload,
  close,
}: {
  entry: Entry;
  snapshot: Snapshot;
  reload: () => Promise<void>;
  close: () => void;
}) {
  const [date, setDate] = useState(localDay());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const target = entry.data;
  if (target.type !== 'milestone' && target.type !== 'todo') return null;
  const records = actualsForDay(snapshot.entries, date);
  return (
    <Modal
      title={`关联做过的事 · ${target.title}`}
      className="node-actual-matcher"
      onClose={() => !busy && close()}
    >
      <DatePicker
        aria-label="做事日期"
        value={date}
        disabled={busy}
        onChange={(event) => {
          if (event.target.value) {
            setDate(event.target.value);
            setFeedback('');
          }
        }}
      />
      <ErrorMessage message={error} />
      {feedback && (
        <p className="record-feedback" role="status">
          {feedback}
        </p>
      )}
      <ul className="node-actual-matches">
        {records.map((actual) => {
          const linked = [...actual.data.milestoneIds, ...actual.data.itemIds].includes(target.id);
          return (
            <li key={actual.data.id}>
              <div>
                <strong>
                  {actual.data.startTime}–{actual.data.endTime}
                </strong>
                <p>{actual.data.description}</p>
              </div>
              <Button
                disabled={busy || linked}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    const key = target.type === 'milestone' ? 'milestoneIds' : 'itemIds';
                    await save(
                      { ...actual.data, [key]: [...new Set([...actual.data[key], target.id])] },
                      actual,
                    );
                    await reload();
                    setFeedback(
                      `已关联 ${actual.data.startTime}–${actual.data.endTime} · ${actual.data.description}`,
                    );
                  } catch (error) {
                    setError(String(error));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {linked ? '已关联' : '关联'}
              </Button>
            </li>
          );
        })}
      </ul>
      {!records.length && <p className="hint">当天还没有实际记录。</p>}
    </Modal>
  );
}
