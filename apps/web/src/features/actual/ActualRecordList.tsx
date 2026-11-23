import type { Entry, Snapshot } from '../../../../../packages/domain/index';
import type { Editor } from '../../types/editor';
import { useEffect, useRef } from 'react';

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
  const consumed = useRef(false);
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
                edit({ type: 'actual', entry });
              }}
              onPointerDown={(event) => {
                consumed.current = false;
                cancel();
                press.current = {
                  x: event.clientX,
                  y: event.clientY,
                  timer: setTimeout(() => {
                    edit({ type: 'actual', entry });
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
                  edit({ type: 'actual', entry });
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
    </div>
  );
}
