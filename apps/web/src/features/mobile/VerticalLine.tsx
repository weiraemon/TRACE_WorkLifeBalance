import { useRef } from 'react';
import { CheckIcon, PlusIcon } from '@radix-ui/react-icons';
import {
  localDay,
  type BusinessLine,
  type Milestone,
  type Snapshot,
  type Todo,
} from '../../../../../packages/domain/index';
import {
  compareMilestones,
  isComplete,
  shouldHideCompleted,
} from '../../../../../packages/domain/workspace';
import { Button } from '../../components/ui';
import { NodeTagIcon } from '../workspace/NodeTagIcon';
import type { AssociationSelection, Editor } from '../../types/editor';

export function VerticalLine({
  snapshot,
  line,
  lines,
  changeLine,
  select,
  edit,
  toggle,
  showOlder,
  association,
}: {
  snapshot: Snapshot;
  line: BusinessLine;
  lines: BusinessLine[];
  changeLine: (id: string) => void;
  select: (id: string) => void;
  edit: (editor: Editor) => void;
  toggle: (id: string) => void;
  showOlder: boolean;
  association?: AssociationSelection;
}) {
  const gesture = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const index = lines.findIndex((item) => item.id === line.id);
  const change = (direction: number) => {
    const next = lines[index + direction];
    if (next) changeLine(next.id);
  };
  const visible = (item: Milestone | Todo) =>
    showOlder || !shouldHideCompleted(item, snapshot.entries, localDay());
  const points = snapshot.entries
    .flatMap(({ data }) =>
      data.type === 'milestone' &&
      data.lineId === line.id &&
      visible(data) &&
      (!association || !isComplete(data, snapshot.entries))
        ? [data]
        : [],
    )
    .sort(compareMilestones);
  return (
    <section
      className="mobile-line-page"
      aria-label={`业务线 · ${line.title}`}
      onPointerDown={(event) => {
        suppressClick.current = false;
        if ((event.target as Element).closest('input, textarea, select')) return;
        gesture.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerCancel={() => {
        gesture.current = null;
      }}
      onPointerUp={(event) => {
        const start = gesture.current;
        gesture.current = null;
        if (!start) return;
        const dx = event.clientX - start.x,
          dy = event.clientY - start.y;
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          suppressClick.current = true;
          change(dx < 0 ? 1 : -1);
        }
      }}
      onClickCapture={(event) => {
        if (suppressClick.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
        }
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget.querySelector('h1')) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          change(event.key === 'ArrowRight' ? 1 : -1);
        }
      }}
    >
      <div className="mobile-line-title">
        <h1 data-space-id={line.id} tabIndex={0}>
          {line.title}
        </h1>
        <Button
          aria-label="添加节点"
          onClick={() => edit({ type: 'milestone', defaults: { lineId: line.id } })}
        >
          <PlusIcon />
        </Button>
      </div>
      <div className="mobile-vertical-track">
        {points.map((point) => {
          const done = isComplete(point, snapshot.entries);
          const todos = snapshot.entries
            .flatMap(({ data }) =>
              data.type === 'todo' &&
              data.milestoneId === point.id &&
              visible(data) &&
              (!association || !isComplete(data, snapshot.entries))
                ? [data]
                : [],
            )
            .sort(
              (a, b) =>
                a.order - b.order ||
                a.createdAt.localeCompare(b.createdAt) ||
                a.id.localeCompare(b.id),
            );
          return (
            <article
              className={`mobile-node${point.pool ? ' mobile-pool' : ''}`}
              key={point.id}
              data-space-id={point.id}
              aria-label={`${point.pool ? '待办池' : '节点'} · ${point.title}`}
            >
              <div className="mobile-node-heading">
                {!point.pool && (
                  <button
                    className={`mobile-todo-check priority-${point.importance}`}
                    role="checkbox"
                    aria-checked={association ? association.has(point.id) : done}
                    aria-label={`${association ? '关联节点' : '完成节点'} ${point.title}`}
                    onClick={() => (association ? association.toggle(point.id) : toggle(point.id))}
                  >
                    {(association ? association.has(point.id) : done) && <CheckIcon />}
                  </button>
                )}
                <div className="mobile-node-content">
                  {!point.pool && (
                    <button
                      className="mobile-node-date"
                      aria-label={`修改时间 · ${point.title}`}
                      disabled={Boolean(association)}
                      onClick={() =>
                        edit({
                          type: 'milestone',
                          entry: snapshot.entries.find(({ data }) => data.id === point.id),
                          defaults: { schedule: true },
                        })
                      }
                    >
                      {point.dueDate ?? '未定'} {point.dueTime}
                    </button>
                  )}
                  <button
                    className={`mobile-node-name priority-${point.importance}${done ? ' mobile-completed' : ''}`}
                    onClick={() =>
                      association ? !point.pool && association.toggle(point.id) : select(point.id)
                    }
                  >
                    {!point.pool &&
                      (point.tags[0] ? (
                        <NodeTagIcon tag={point.tags[0]} />
                      ) : (
                        <span className="mobile-node-tag-dot" />
                      ))}
                    <span>{point.pool ? '待办池' : point.title}</span>
                  </button>
                </div>
                <Button
                  aria-label={`添加 TODO / IDEA · ${point.title}`}
                  onClick={() => edit({ type: 'todo', defaults: { milestoneId: point.id } })}
                >
                  <PlusIcon />
                </Button>
              </div>
              <ul className="mobile-todos">
                {todos.map((todo) => {
                  const completed = isComplete(todo, snapshot.entries);
                  return (
                    <li key={todo.id} data-space-id={todo.id}>
                      <button
                        className={`mobile-todo-check priority-${todo.importance}`}
                        role="checkbox"
                        aria-checked={association ? association.has(todo.id) : completed}
                        aria-label={`${association ? '关联条目' : '完成'} ${todo.title}`}
                        onClick={() =>
                          association ? association.toggle(todo.id) : toggle(todo.id)
                        }
                      >
                        {(association ? association.has(todo.id) : completed) && <CheckIcon />}
                      </button>
                      <button
                        className={`mobile-todo-title${completed ? ' mobile-completed' : ''}`}
                        onClick={() =>
                          association ? association.toggle(todo.id) : select(todo.id)
                        }
                      >
                        {todo.kind === 'idea' && <small>IDEA · </small>}
                        {todo.title}
                        {todo.direction !== 'self' && (
                          <small className="mobile-todo-meta">
                            {`${todo.direction === 'from' ? '等' : '找'} ${todo.person}`}
                          </small>
                        )}
                      </button>
                      {!association && (
                        <button
                          className="mobile-node-date"
                          aria-label={`修改日期 · ${todo.title}`}
                          onClick={() =>
                            edit({
                              type: 'todo',
                              entry: snapshot.entries.find(({ data }) => data.id === todo.id),
                              defaults: { schedule: true },
                            })
                          }
                        >
                          {todo.dueDate ?? point.dueDate ?? '未定'}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </article>
          );
        })}
      </div>
    </section>
  );
}
