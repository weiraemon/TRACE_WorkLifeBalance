import type { Entry, Snapshot } from '../../../../../packages/domain/index';
import type { Editor } from '../../types/editor';
import { useEffect, useRef, useState } from 'react';
import { Button, ErrorMessage, Modal } from '../../components/ui';
import { deleteActual } from '../../api';

export function ActualRecordList({
  entries,
  snapshot,
  edit,
  reload,
}: {
  entries: Entry[];
  snapshot: Snapshot;
  edit: (editor: Editor) => void;
  reload: () => Promise<void>;
}) {
  const [target, setTarget] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => cancel, []);
  return (
    <div className="actual-record-list">
      <ErrorMessage message={error} />
      {entries.map(
        (entry) =>
          entry.data.type === 'actual' && (
            <article
              key={entry.data.id}
              data-actual-id={entry.data.id}
              tabIndex={0}
              onContextMenu={(event) => {
                event.preventDefault();
                cancel();
                setTarget(entry);
              }}
              onPointerDown={(event) => {
                if (event.pointerType === 'mouse' || (event.target as Element).closest('button'))
                  return;
                cancel();
                press.current = {
                  x: event.clientX,
                  y: event.clientY,
                  timer: setTimeout(() => {
                    setTarget(entry);
                    press.current = null;
                  }, 500),
                };
              }}
              onPointerMove={(event) => {
                if (
                  press.current &&
                  Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8
                )
                  cancel();
              }}
              onPointerUp={cancel}
              onPointerCancel={cancel}
              onKeyDown={(event) => {
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault();
                  setTarget(entry);
                }
              }}
            >
              <time>
                {entry.data.startTime}–{entry.data.endTime}
              </time>
              <p>{entry.data.description}</p>
              <small>
                {[...entry.data.milestoneIds, ...entry.data.itemIds]
                  .map((id) => snapshot.entries.find((e) => e.data.id === id)?.data)
                  .map((item) => (item && 'title' in item ? item.title : '关联内容已移除'))
                  .join(' / ') || '未关联'}
              </small>
              <button
                onClick={() => edit({ type: 'actual', entry })}
                aria-label={`编辑记录 · ${entry.data.description}`}
              >
                修改
              </button>
            </article>
          ),
      )}
      {target && target.data.type === 'actual' && (
        <Modal
          title="实际记录操作"
          onClose={() => setTarget(null)}
          className="mobile-actions-dialog"
        >
          <p>{target.data.description}</p>
          <div className="actions">
            <Button
              onClick={() => {
                edit({ type: 'actual', entry: target });
                setTarget(null);
              }}
            >
              修改记录
            </Button>
            <Button
              className="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await deleteActual(target);
                  await reload();
                  setTarget(null);
                } catch (error) {
                  setError(String(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '正在删除…' : '删除记录'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
