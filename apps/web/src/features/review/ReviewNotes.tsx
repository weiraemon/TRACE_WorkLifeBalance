import type { Snapshot } from '../../../../../packages/domain/index';
import type { ReviewData } from './reviewData';
export function ReviewNotes({ data, snapshot }: { data: ReviewData; snapshot: Snapshot }) {
  const { completed, week } = data;
  return (
    <>
      {completed.length > 0 && (
        <details className="review-completed" open>
          <summary>本周完成 · {completed.length}</summary>
          <ul>
            {completed.map((c) => (
              <li key={c.todo.id}>
                {c.todo.title}
                <small>{c.line.title}</small>
              </li>
            ))}
          </ul>
        </details>
      )}
      {snapshot.entries.map(
        (e) =>
          e.data.type === 'review' &&
          e.data.week === week && (
            <article className="review-note" key={e.data.id}>
              <h2>{e.data.mainline || '周复盘'}</h2>
              <p className="preserve">{e.data.outcomes}</p>
              <p className="preserve">{e.data.reflection}</p>
              {e.data.nextWeek && (
                <>
                  <h3>下周继续</h3>
                  <p className="preserve">{e.data.nextWeek}</p>
                </>
              )}
            </article>
          ),
      )}{' '}
    </>
  );
}
