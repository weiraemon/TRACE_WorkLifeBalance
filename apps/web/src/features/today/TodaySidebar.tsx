import { timeTotals, type Snapshot } from '../../../../../packages/domain/index';
import { contactsForDay } from '../../../../../packages/domain/workspace';
import type { Editor } from '../../types/editor';
import { ActualRecordList } from '../actual/ActualRecordList';
import { actualsForDay } from '../actual/selectors';
export function TodaySidebar({
  snapshot,
  date,
  lineId,
  goWorkspace,
  editActual,
}: {
  snapshot: Snapshot;
  date: string;
  lineId: string;
  goWorkspace: (id: string) => void;
  editActual: (editor: Editor) => void;
}) {
  const contacts = contactsForDay(snapshot.entries, date)
    .flatMap((group) => group.todos)
    .filter((context) => !lineId || context.line.id === lineId);
  const actuals = actualsForDay(snapshot.entries, date).reverse();
  return (
    <aside className="today-contacts" aria-label="联络侧栏">
      <div className="section-heading">
        <h2>今天联系谁</h2>
        <small>{contacts.length}</small>
      </div>
      <section className="contact-list" aria-label="今天联系谁">
        {contacts.length ? (
          <ul className="contact-rows">
            {contacts.map((c) => (
              <li key={c.todo.id} data-space-id={c.todo.id}>
                <button className="contact-row" onClick={() => goWorkspace(c.todo.id)}>
                  <strong className="contact-person">
                    {c.todo.direction === 'from' ? '等' : '找'} {c.todo.person}
                  </strong>
                  <span className="contact-task">{c.todo.title}</span>
                  <small>{c.line.title}</small>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">没有当天需要交接或催收的事项。</p>
        )}
      </section>
      <section className="today-actuals" aria-label="当天实际记录">
        <h3>
          已记录 · {actuals.length} 段{' '}
          <small>{(timeTotals(snapshot.entries, date, date).total / 60).toFixed(1)} h</small>
        </h3>
        <ActualRecordList entries={actuals} snapshot={snapshot} edit={editActual} />
        {!actuals.length && <p className="hint">当天还没有实际记录。</p>}
      </section>
    </aside>
  );
}
