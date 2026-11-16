import type { Entry, Snapshot } from '../../../../../packages/domain/index';
import type { Editor } from '../../types/editor';
import { useEffect, useRef, useState } from 'react';
import { Button, ErrorMessage, Modal } from '../../components/ui';
import { deleteActual } from '../../api';
import { ActualAssociationMode } from './ActualAssociationMode';

export function ActualRecordList({
  entries,
  snapshot,
  edit,
  reload,
  recentId,
}: {
  entries: Entry[];
  snapshot: Snapshot;
  edit: (editor: Editor) => void;
  reload: () => Promise<void>;
  recentId?: string;
}) {
  const [target, setTarget] = useState<Entry | null>(null);
  const [associationId, setAssociationId] = useState<string | null>(null);
  const associationEntry = entries.find((entry) => entry.data.id === associationId);
  const defaultAssociationId =
    entries.find((entry) => entry.data.id === recentId)?.data.id ?? entries.at(-1)?.data.id;
  const consumed = useRef(false);
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
      {recentId && entries.some((entry) => entry.data.id === recentId) && (
        <p className="record-feedback" role="status">
          已保存，记录已添加到下方。
        </p>
      )}
      {entries.length > 0 && (
        <Button
          className="association-mode-entry"
          onClick={() => setAssociationId(defaultAssociationId ?? null)}
        >
          关联模式
        </Button>
      )}
      <ErrorMessage message={error} />
      {entries.map(
        (entry) =>
          entry.data.type === 'actual' && (
            <article
              key={entry.data.id}
              data-actual-id={entry.data.id}
              data-recent={entry.data.id === recentId}
              tabIndex={0}
              onContextMenu={(event) => {
                event.preventDefault();
                cancel();
                setTarget(entry);
              }}
              onPointerDown={(event) => {
                consumed.current = false;
                if (event.pointerType === 'mouse') return;
                cancel();
                press.current = {
                  x: event.clientX,
                  y: event.clientY,
                  timer: setTimeout(() => {
                    setTarget(entry);
                    consumed.current = true;
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
              onClickCapture={(event) => {
                if (consumed.current) {
                  event.preventDefault();
                  event.stopPropagation();
                  consumed.current = false;
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault();
                  setTarget(entry);
                }
              }}
            >
              <button
                className="actual-record-content"
                aria-label={`编辑记录 · ${entry.data.description}`}
                onClick={() => edit({ type: 'actual', entry })}
              >
                <time>
                  {entry.data.startTime}–{entry.data.endTime}
                </time>
                <span className="actual-record-description">{entry.data.description}</span>
                <small>
                  {[...entry.data.milestoneIds, ...entry.data.itemIds]
                    .map((id) => snapshot.entries.find((e) => e.data.id === id)?.data)
                    .map((item) => (item && 'title' in item ? item.title : '关联内容已移除'))
                    .join(' / ') || '未关联'}
                </small>
              </button>
            </article>
          ),
      )}
      {associationEntry && (
        <ActualAssociationMode
          key={associationEntry.data.id}
          entry={associationEntry}
          entries={entries}
          snapshot={snapshot}
          choose={setAssociationId}
          close={() => setAssociationId(null)}
          reload={reload}
        />
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
