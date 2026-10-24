import {
  localDay,
  timeTotals,
  isSpaceItem,
  type Snapshot,
} from '../../../../packages/domain/index';
import { todoContexts, todoStatus } from '../../../../packages/domain/workspace';
import type { Editor } from '../features/editor';
import { DatePicker } from '../components/ui';
export function Review({
  snapshot,
  week,
  setDate,
  edit,
  select,
}: {
  snapshot: Snapshot;
  week: string;
  setDate: (d: string) => void;
  edit: (e: Editor) => void;
  select: (id: string) => void;
}) {
  const end = new Date(week + 'T12:00:00');
  end.setDate(end.getDate() + 6);
  const last = localDay(end);
  const totals = timeTotals(snapshot.entries, week, last);
  const actuals = snapshot.entries.filter(
    (e) => e.data.type === 'actual' && e.data.date >= week && e.data.date <= last,
  );
  const completedIds = new Set(
    actuals.flatMap((e) => (e.data.type === 'actual' ? e.data.completedTodoIds : [])),
  );
  const completed = todoContexts(snapshot.entries).filter(
    (c) =>
      completedIds.has(c.todo.id) ||
      (c.todo.status === 'Done' &&
        localDay(new Date(c.todo.updatedAt)) >= week &&
        localDay(new Date(c.todo.updatedAt)) <= last),
  );
  const waiting = snapshot.entries.filter(
    (e) =>
      isSpaceItem(e.data) &&
      (['Waiting', 'Blocked'].includes(e.data.status) ||
        (e.data.type === 'todo' &&
          e.data.direction === 'from' &&
          !['Done', 'Cancelled'].includes(todoStatus(e.data, snapshot.entries)))),
  );
  return (
    <>
      <div className="section-heading">
        <h2>
          {week} — {last}
        </h2>
        <DatePicker
          aria-label="复盘周"
          value={week}
          onChange={(e) => e.target.value && setDate(e.target.value)}
        />
      </div>
      <section>
        <h3>实际投入 · {(totals.total / 60).toFixed(2)} h</h3>
        <Totals values={totals.projects} />
      </section>
      <div className="review-columns">
        <section>
          <h3>本周完成</h3>
          {completed.map((c) => (
            <button className="node-link" key={c.todo.id} onClick={() => select(c.todo.id)}>
              {c.todo.title}
            </button>
          ))}
          {!completed.length && <p className="hint">本周暂无完成的待办。</p>}
        </section>
        <section>
          <h3>阻塞与待反馈</h3>
          {waiting.map(
            (e) =>
              isSpaceItem(e.data) && (
                <button className="node-link" key={e.data.id} onClick={() => select(e.data.id)}>
                  {e.data.title}
                </button>
              ),
          )}
        </section>
      </div>
      <section>
        <h3>实际工作</h3>
        {actuals.map(
          (e) =>
            e.data.type === 'actual' && (
              <p key={e.data.id}>
                {e.data.date} {e.data.startTime}–{e.data.endTime} · {e.data.description}
              </p>
            ),
        )}
      </section>
      <section>
        <h2>周复盘</h2>
        {snapshot.entries.map(
          (e) =>
            e.data.type === 'review' &&
            e.data.week === week && (
              <button
                className="review-note"
                key={e.data.id}
                onClick={() => edit({ type: 'review', entry: e })}
              >
                <h3>{e.data.mainline}</h3>
                <p className="preserve">{e.data.outcomes}</p>
                <p className="preserve">{e.data.reflection}</p>
                <strong>下周继续</strong>
                <p className="preserve">{e.data.nextWeek}</p>
              </button>
            ),
        )}
      </section>
    </>
  );
}
export function Totals({ values }: { values: Record<string, number> }) {
  return (
    <dl className="totals">
      {Object.entries(values).map(([key, minutes]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{(minutes / 60).toFixed(2)} h</dd>
        </div>
      ))}
    </dl>
  );
}
