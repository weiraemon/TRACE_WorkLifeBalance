import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, CheckIcon } from '@radix-ui/react-icons';
import {
  lineKindLabel,
  isSpaceItem,
  type Project,
  type BusinessLine,
  type Milestone,
  type Entry,
  type Snapshot,
  type SpaceItem,
  type Todo,
} from '../../../../packages/domain/index';
import { todoStatus, compareMilestones } from '../../../../packages/domain/workspace';
import { createRecord, save } from '../api';
import { Button, EmptyState } from '../components/ui';
import { ImportanceDot, importanceLabel } from '../components/Importance';
import type { Editor } from './editor';
import { spaceLabel } from './WorkItemForm';
export function TodoRows({
  todos,
  entries,
  select,
  toggle,
}: {
  todos: Todo[];
  entries: Entry[];
  select?: (id: string) => void;
  toggle?: (todo: Todo) => void;
}) {
  return (
    <ul className="todo-rows">
      {todos.map((todo) => {
        const done = todoStatus(todo, entries) === 'Done';
        return (
          <li key={todo.id} data-space-id={todo.id} className={done ? 'todo-done' : ''}>
            <button
              type="button"
              role="checkbox"
              className={`todo-check priority-${todo.importance}`}
              aria-label={`完成 ${todo.title}`}
              aria-checked={done}
              disabled={!toggle}
              onClick={() => toggle?.(todo)}
            >
              {done && <CheckIcon />}
            </button>
            <div>
              {select ? (
                <button className="todo-title" onClick={() => select(todo.id)}>
                  {todo.title}
                </button>
              ) : (
                <span>{todo.title}</span>
              )}
              {(todo.direction !== 'self' || todo.estimatedMinutes) && (
                <small>
                  {[
                    todo.direction !== 'self'
                      ? `${todo.direction === 'to' ? 'To' : 'From'} ${todo.person}`
                      : '',
                    todo.estimatedMinutes ? `${todo.estimatedMinutes} 分钟` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
export function WorkspaceBoard({
  snapshot,
  edit,
  select,
  reload,
  run,
  query,
  showArchived,
  requestDelete,
}: {
  snapshot: Snapshot;
  edit: (e: Editor) => void;
  select: (id: string) => void;
  reload: () => Promise<void>;
  run: (fn: () => Promise<unknown>) => void;
  query: string;
  showArchived: boolean;
  requestDelete: (entry: Entry) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<{
    entry: Entry;
    x: number;
    y: number;
    trigger: HTMLElement;
  } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        menu.trigger.querySelector('button')?.focus();
        close();
      } else if (event.key === 'Tab') close();
      else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) event.preventDefault();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);
  const contextMenu = (event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => {
    if (
      event.type === 'keydown' &&
      (event as KeyboardEvent).key !== 'ContextMenu' &&
      !((event as KeyboardEvent).shiftKey && (event as KeyboardEvent).key === 'F10')
    )
      return;
    const target = (event.target as Element).closest<HTMLElement>('[data-space-id]');
    const entry = snapshot.entries.find((e) => e.data.id === target?.dataset.spaceId);
    if (!target || !entry || !isSpaceItem(entry.data)) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    const mouse = event as MouseEvent;
    setMenu({
      entry,
      trigger: target,
      x: Math.max(8, Math.min(mouse.clientX || rect.left + 16, window.innerWidth - 238)),
      y: Math.max(8, Math.min(mouse.clientY || rect.top + 16, window.innerHeight - 100)),
    });
  };
  const records = snapshot.entries
    .map((e) => e.data)
    .filter(isSpaceItem)
    .sort(
      (a, b) =>
        a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  const live = (r: SpaceItem) => showArchived || !['Done', 'Cancelled'].includes(r.status);
  const projects = records.filter((r): r is Project => r.type === 'project' && live(r));
  const change = (r: SpaceItem, fields: object) =>
    run(async () => {
      await save(
        createRecord(r.type, { ...r, ...fields }),
        snapshot.entries.find((e) => e.data.id === r.id),
      );
      await reload();
    });
  const toggle = (todo: Todo) => {
    if (todoStatus(todo, snapshot.entries) === 'Done' && todo.status !== 'Done') {
      run(async () => {
        throw new Error('这项待办已关联实际工作；请到今日编辑对应实际记录，移除完成关联后恢复。');
      });
      return;
    }
    change(todo, { status: todo.status === 'Done' ? 'Ready' : 'Done' });
  };
  return (
    <div className="space-board" onContextMenu={contextMenu} onKeyDown={contextMenu}>
      {menu &&
        isSpaceItem(menu.entry.data) &&
        createPortal(
          <div
            className="space-context-menu"
            role="menu"
            aria-label={`${menu.entry.data.title} 操作`}
            style={{ left: menu.x, top: menu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <span title={menu.entry.data.title}>{menu.entry.data.title}</span>
            <button
              role="menuitem"
              className="button danger"
              ref={(node) => {
                node?.focus({ preventScroll: true });
              }}
              onClick={() => {
                requestDelete(menu.entry);
                setMenu(null);
              }}
            >
              删除{spaceLabel[menu.entry.data.type]}
            </button>
          </div>,
          document.body,
        )}
      {projects.length === 0 && <EmptyState>暂无项目</EmptyState>}
      {projects.map((project) => {
        const lines = records
          .filter(
            (r): r is BusinessLine =>
              r.type === 'workline' && r.projectId === project.id && live(r),
          )
          .sort((a, b) => a.order - b.order);
        const pointIds = new Set(
          records
            .filter((r) => r.type === 'milestone' && lines.some((l) => l.id === r.lineId))
            .map((r) => r.id),
        );
        if (
          query &&
          ![
            project,
            ...lines,
            ...records.filter(
              (r) => pointIds.has(r.id) || (r.type === 'todo' && pointIds.has(r.milestoneId)),
            ),
          ].some((r) => 'title' in r && r.title.toLowerCase().includes(query))
        )
          return null;
        const folded = collapsed.has(project.id);
        return (
          <section
            className="project-plane"
            key={project.id}
            data-space-id={project.id}
            aria-label={`项目面 · ${project.title}`}
          >
            <div className="project-heading">
              <button
                className="plane-toggle"
                aria-expanded={!folded}
                aria-label={`${folded ? '展开' : '收缩'}项目 ${project.title}`}
                onClick={() =>
                  setCollapsed((s) => {
                    const next = new Set(s);
                    if (folded) next.delete(project.id);
                    else next.add(project.id);
                    return next;
                  })
                }
              >
                {folded ? <ChevronRightIcon /> : <ChevronDownIcon />}
                <strong>{project.title}</strong>
                <small>{lines.length} 条业务线</small>
              </button>
              <Button
                className="icon"
                aria-label={`编辑项目 ${project.title}`}
                onClick={() =>
                  edit({
                    type: 'project',
                    entry: snapshot.entries.find((e) => e.data.id === project.id),
                  })
                }
              >
                ···
              </Button>
              <Button
                onClick={() => edit({ type: 'workline', defaults: { projectId: project.id } })}
              >
                <PlusIcon />
                业务线
              </Button>
            </div>
            {!folded && (
              <div className="plane-content">
                {lines.map((line) => {
                  const points = records
                    .filter(
                      (r): r is Milestone =>
                        r.type === 'milestone' && r.lineId === line.id && live(r),
                    )
                    .sort(compareMilestones);
                  return (
                    <section
                      className="business-track"
                      key={line.id}
                      data-space-id={line.id}
                      aria-label={`业务线 · ${line.title}`}
                    >
                      <div className="track-heading">
                        <button onClick={() => select(line.id)}>
                          <strong>{line.title}</strong>
                          <small>{lineKindLabel[line.kind]}</small>
                        </button>
                        <button
                          className="line-importance"
                          aria-label={`编辑重要性 · ${line.title}`}
                          onClick={() =>
                            edit({
                              type: 'workline',
                              entry: snapshot.entries.find((e) => e.data.id === line.id),
                            })
                          }
                        >
                          <ImportanceDot value={line.importance} />
                        </button>
                      </div>
                      <div className="track-scroll">
                        <div className="track-points">
                          {points.map((point) => (
                            <article
                              className="milestone-point"
                              key={point.id}
                              data-space-id={point.id}
                              aria-label={`关键节点 · ${point.title}`}
                            >
                              <button
                                className="point-dates"
                                aria-label={`调整日期 · ${point.title}`}
                                onClick={() =>
                                  edit({
                                    type: 'milestone',
                                    entry: snapshot.entries.find((e) => e.data.id === point.id),
                                  })
                                }
                              >
                                <span>
                                  截止 {point.dueDate ?? '未定'} {point.dueTime}
                                </span>
                              </button>
                              <div className="point-marker-row">
                                <button
                                  className={`point-dot priority-${point.importance}`}
                                  aria-label={`查看节点 ${point.title} · ${importanceLabel(point.importance)}`}
                                  title={`${point.title} · ${importanceLabel(point.importance)}`}
                                  onClick={() => select(point.id)}
                                />
                              </div>
                              <button className="point-title" onClick={() => select(point.id)}>
                                {point.title}
                              </button>
                              <TodoRows
                                entries={snapshot.entries}
                                todos={records.filter(
                                  (r): r is Todo =>
                                    r.type === 'todo' &&
                                    r.milestoneId === point.id &&
                                    (showArchived || r.status !== 'Cancelled'),
                                )}
                                select={select}
                                toggle={toggle}
                              />
                              <Button
                                className="add-todo"
                                onClick={() =>
                                  edit({ type: 'todo', defaults: { milestoneId: point.id } })
                                }
                              >
                                <PlusIcon />
                                待办
                              </Button>
                            </article>
                          ))}
                          <button
                            className="add-point"
                            onClick={() =>
                              edit({
                                type: 'milestone',
                                defaults: { lineId: line.id },
                              })
                            }
                          >
                            <PlusIcon />
                            关键节点
                          </button>
                        </div>
                      </div>
                    </section>
                  );
                })}
                {!lines.length && <p className="plane-empty">暂无业务线</p>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
