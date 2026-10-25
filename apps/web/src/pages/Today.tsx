import type { ReactNode } from 'react';
import { todosForDay, contactsForDay } from '../../../../packages/domain/workspace';
import type { Snapshot } from '../../../../packages/domain/index';
import { EmptyState } from '../components/ui';
import { ImportanceDot } from '../components/Importance';
import { QuickCapture } from '../features/QuickCapture';
import { save } from '../api';
export function Today({
  snapshot,
  date,
  goWorkspace,
  timeline,
  reload,
  run,
}: {
  snapshot: Snapshot;
  date: string;
  goWorkspace: (id?: string) => void;
  timeline: ReactNode;
  reload: () => Promise<void>;
  run: (fn: () => Promise<unknown>) => void;
}) {
  const contexts = todosForDay(snapshot.entries, date);
  const contacts = contactsForDay(snapshot.entries, date)
    .flatMap((group) => group.todos)
    .sort((a, b) => b.todo.importance - a.todo.importance);
  return (
    <div className="today-layout">
      <div className="today-timeline">{timeline}</div>
      <div className="today-lists">
        <QuickCapture
          snapshot={snapshot}
          onCreate={async (item, comment) => {
            await save(item, undefined, {
              comments: comment.trim()
                ? [{ id: crypto.randomUUID(), targetId: item.id, text: comment }]
                : [],
            });
            await reload();
          }}
        />
        <section className="today-work" aria-label="当天待办">
          <div className="section-heading">
            <h2>
              当天待办 <span className="count">{contexts.length}</span>
            </h2>
            <button className="text-link" onClick={() => goWorkspace()}>
              工作空间 →
            </button>
          </div>
          {!contexts.length ? (
            <EmptyState>当天没有已安排的待办。</EmptyState>
          ) : (
            <ul className="today-todos">
              {contexts.map((c) => (
                <li key={c.todo.id} data-space-id={c.todo.id} className="today-item-row">
                  <button
                    className={`todo-check priority-${c.todo.importance}`}
                    role="checkbox"
                    aria-label={`完成 ${c.todo.title}`}
                    aria-checked={Boolean(c.todo.completedAt)}
                    onClick={() =>
                      run(async () => {
                        await save(
                          c.todo,
                          snapshot.entries.find((e) => e.data.id === c.todo.id),
                          { completion: !c.todo.completedAt },
                        );
                        await reload();
                      })
                    }
                  >
                    {c.todo.completedAt ? '✓' : ''}
                  </button>
                  <button
                    className={`today-row${c.todo.completedAt ? ' today-row-done' : ''}`}
                    onClick={() => goWorkspace(c.todo.id)}
                  >
                    <span className="today-task" title={c.todo.title}>
                      <ImportanceDot value={c.todo.importance} />
                      {c.todo.kind === 'idea' ? 'IDEA · ' : ''}
                      {c.todo.title}
                    </span>
                    <span
                      className="row-context"
                      title={`${c.project.title} / ${c.milestone.title}`}
                    >
                      {c.project.title} / {c.milestone.title}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="contact-agenda" aria-label="今天联系谁">
          <div className="section-heading">
            <h2>今天联系谁</h2>
          </div>
          {!contacts.length ? (
            <p className="hint">没有当天需要交接或催收的事项。</p>
          ) : (
            <ul className="contact-rows">
              {contacts.map((c) => (
                <li key={c.todo.id} data-space-id={c.todo.id}>
                  <button className="contact-row" onClick={() => goWorkspace(c.todo.id)}>
                    <strong className="contact-person">
                      {c.todo.direction === 'from' ? '等' : '找'} {c.todo.person}
                    </strong>
                    <span className="contact-task" title={c.todo.title}>
                      <ImportanceDot value={c.todo.importance} />
                      {c.todo.title}
                    </span>
                    <span
                      className="row-context"
                      title={`${c.project.title} / ${c.milestone.title}`}
                    >
                      {c.project.title} / {c.milestone.title}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
