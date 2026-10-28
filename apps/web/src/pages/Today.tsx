import type { ReactNode } from 'react';
import {
  todosForDay,
  contactsForDay,
  milestonesForDay,
  isComplete,
} from '../../../../packages/domain/workspace';
import type { Snapshot } from '../../../../packages/domain/index';
import { EmptyState, DatePicker } from '../components/ui';
import { ImportanceDot } from '../components/Importance';
import { TodayCapture } from '../features/TodayCapture';
import { OverdueTodos } from '../features/OverdueTodos';
import { OverdueEvents } from '../features/OverdueEvents';
import type { Editor } from '../features/editor';
import { save } from '../api';
export function Today({
  snapshot,
  date,
  setDate,
  goWorkspace,
  timeline,
  reload,
  run,
  actualEditor,
  dismissActualEditor,
}: {
  snapshot: Snapshot;
  date: string;
  setDate: (date: string) => void;
  goWorkspace: (id?: string) => void;
  timeline: ReactNode;
  reload: () => Promise<void>;
  run: (fn: () => Promise<unknown>) => void;
  actualEditor?: Editor;
  dismissActualEditor: () => void;
}) {
  const contexts = todosForDay(snapshot.entries, date);
  const nodes = milestonesForDay(snapshot.entries, date);
  const contacts = contactsForDay(snapshot.entries, date)
    .flatMap((group) => group.todos)
    .sort((a, b) => b.todo.importance - a.todo.importance);
  return (
    <div className="space-board today-board">
      <nav className="today-agenda" aria-label="今日导航">
        <div className="today-agenda-scroll">
          <OverdueEvents snapshot={snapshot} date={date} reload={reload} />
          <OverdueTodos snapshot={snapshot} date={date} reload={reload} />
          <details open className="today-nav-group">
            <summary>
              今日待办 <small>{contexts.length + nodes.length}</small>
            </summary>
            <section className="today-work" aria-label="当天待办">
              {!contexts.length && !nodes.length ? (
                <EmptyState>当天没有已安排的待办。</EmptyState>
              ) : (
                <ul className="today-todos">
                  {nodes.map((context) => {
                    const done = isComplete(context.milestone, snapshot.entries);
                    return (
                      <li
                        key={context.milestone.id}
                        data-space-id={context.milestone.id}
                        className={`today-item-row${done ? ' today-row-done' : ''}`}
                      >
                        <button
                          className={`todo-check priority-${context.milestone.importance}`}
                          role="checkbox"
                          aria-label={`完成节点 ${context.milestone.title}`}
                          aria-checked={done}
                          onClick={() =>
                            run(async () => {
                              await save(
                                {
                                  ...context.milestone,
                                  completedAt: done ? null : new Date().toISOString(),
                                },
                                snapshot.entries.find((e) => e.data.id === context.milestone.id),
                                { completion: !done },
                              );
                              await reload();
                            })
                          }
                        >
                          {done ? '✓' : ''}
                        </button>
                        <button
                          className="today-row"
                          onClick={() => goWorkspace(context.milestone.id)}
                        >
                          <span className="today-task" title={context.milestone.title}>
                            <ImportanceDot value={context.milestone.importance} />
                            节点 · {context.milestone.title}
                          </span>
                          <span
                            className="row-context"
                            title={`${context.project.title} / ${context.line.title}`}
                          >
                            {context.project.title} / {context.line.title}
                          </span>
                        </button>
                      </li>
                    );
                  })}
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
          </details>
          <details open className="today-nav-group">
            <summary>
              今天联系谁 <small>{contacts.length}</small>
            </summary>
            <section className="contact-agenda" aria-label="今天联系谁">
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
          </details>
        </div>
        <div className="today-nav-date">
          <label>
            查看日期
            <DatePicker
              aria-label="查看日期"
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
          </label>
        </div>
      </nav>
      <div className="workspace-content today-content">
        <div className="today-layout">
          <div className="today-timeline">{timeline}</div>
          <div className="today-lists">
            <TodayCapture
              snapshot={snapshot}
              date={date}
              editor={actualEditor}
              dismissEditor={dismissActualEditor}
              reload={reload}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
