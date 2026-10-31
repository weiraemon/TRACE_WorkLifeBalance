import type { Snapshot, SpaceItem, Todo, Milestone } from '../../../../../packages/domain/index';
import { agendaForDay, activeLines } from '../../../../../packages/domain/workspace';
import { EmptyState } from '../../components/ui';
import { ImportanceDot } from '../../components/Importance';
import { OverdueEvents } from './OverdueEvents';
import { OverdueTodos } from './OverdueTodos';
import { TodayNodeRow } from './TodayNodeRow';
export function TodayAgenda({
  snapshot,
  date,
  lineId,
  setLineId,
  reload,
  goWorkspace,
  toggle,
  record,
}: {
  snapshot: Snapshot;
  date: string;
  lineId: string;
  setLineId: (id: string) => void;
  reload: () => Promise<void>;
  goWorkspace: (id: string) => void;
  toggle: (item: SpaceItem) => void;
  record: (item: Todo | Milestone) => void;
}) {
  const agenda = agendaForDay(snapshot.entries, date).filter(
    (row) => !lineId || row.context.line.id === lineId,
  );
  const lines = activeLines(snapshot.entries);
  return (
    <nav className="today-agenda" aria-label="今日导航">
      <div className="section-heading">
        <h2>今天要做</h2>
        <span className="hint">{agenda.length} 项安排</span>
      </div>
      <select
        className="line-dropdown"
        aria-label="筛选业务线"
        value={lineId}
        onChange={(e) => setLineId(e.target.value)}
      >
        <option value="">全部业务线</option>
        {lines.map((line) => (
          <option key={line.id} value={line.id}>
            {line.title}
          </option>
        ))}
      </select>
      <OverdueEvents snapshot={snapshot} date={date} reload={reload} />
      <OverdueTodos snapshot={snapshot} date={date} reload={reload} />
      <section className="today-work" aria-label="当天待办">
        {!agenda.length ? (
          <EmptyState>当天没有已安排的待办。</EmptyState>
        ) : (
          <ul className="today-todos">
            {agenda.map(({ context, item, done }) =>
              item.type === 'milestone' ? (
                <TodayNodeRow
                  key={item.id}
                  context={{ ...context, milestone: item }}
                  snapshot={snapshot}
                  toggle={toggle}
                  record={() => record(item)}
                />
              ) : (
                <li
                  key={item.id}
                  data-space-id={item.id}
                  className={`today-item-row${done ? ' today-row-done' : ''}`}
                >
                  <button
                    className={`todo-check priority-${item.importance}`}
                    role="checkbox"
                    aria-label={`完成 ${item.title}`}
                    aria-checked={done}
                    onClick={() => toggle(item)}
                  >
                    {done ? '✓' : ''}
                  </button>
                  <button className="today-row" onClick={() => goWorkspace(item.id)}>
                    <span className="today-task" title={item.title}>
                      <small>{context.line.title}</small>
                      <span>
                        <ImportanceDot value={item.importance} />
                        {item.kind === 'idea' ? 'IDEA · ' : ''}
                        {item.title}
                      </span>
                    </span>
                  </button>
                  <button
                    className="record-source"
                    aria-label={`记一段 · ${item.title}`}
                    onClick={() => record(item)}
                  >
                    记一段
                  </button>
                </li>
              ),
            )}
          </ul>
        )}
      </section>
    </nav>
  );
}
