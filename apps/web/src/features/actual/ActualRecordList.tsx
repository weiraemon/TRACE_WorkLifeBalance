import type { Entry, Snapshot } from '../../../../../packages/domain/index';
import type { Editor } from '../../types/editor';

export function ActualRecordList({
  entries,
  snapshot,
  edit,
}: {
  entries: Entry[];
  snapshot: Snapshot;
  edit: (editor: Editor) => void;
}) {
  return (
    <div className="actual-record-list">
      {entries.map(
        (entry) =>
          entry.data.type === 'actual' && (
            <article key={entry.data.id}>
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
    </div>
  );
}
