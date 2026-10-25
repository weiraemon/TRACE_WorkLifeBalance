import { useRef, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, CheckIcon } from '@radix-ui/react-icons';
import {
  isSpaceItem,
  type Project,
  type BusinessLine,
  type Milestone,
  type Entry,
  type Snapshot,
  type SpaceItem,
  type Todo,
} from '../../../../packages/domain/index';
import { isComplete, compareMilestones } from '../../../../packages/domain/workspace';
import { createRecord, save } from '../api';
import { Button, EmptyState } from '../components/ui';
import { ImportanceDot, importanceLabel } from '../components/Importance';
import type { Editor } from './editor';
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
        const done = isComplete(todo, entries);
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
                  {todo.kind === 'idea' ? 'IDEA · ' : ''}
                  {todo.title}
                </button>
              ) : (
                <span>
                  {todo.kind === 'idea' ? 'IDEA · ' : ''}
                  {todo.title}
                </span>
              )}
              {(todo.dueDate || todo.direction !== 'self') && (
                <small>
                  {[
                    todo.direction !== 'self'
                      ? `${todo.direction === 'to' ? 'To' : 'From'} ${todo.person}`
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  {todo.dueDate && (
                    <button
                      className="todo-date"
                      type="button"
                      aria-label={`待办日期 · ${todo.title}`}
                    >
                      {todo.dueDate}
                    </button>
                  )}
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
  onShowArchivedChange,
}: {
  snapshot: Snapshot;
  edit: (e: Editor) => void;
  select: (id: string) => void;
  reload: () => Promise<void>;
  run: (fn: () => Promise<unknown>) => void;
  query: string;
  showArchived: boolean;
  onShowArchivedChange: (show: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState('');
  const content = useRef<HTMLDivElement>(null);
  const records = snapshot.entries
    .map((e) => e.data)
    .filter(isSpaceItem)
    .sort(
      (a, b) =>
        a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  const live = (r: SpaceItem) => showArchived || !r.completedAt;
  const projects = records.filter((r): r is Project => r.type === 'project' && live(r));
  const groups = projects
    .map((project) => {
      const lines = records.filter(
        (r): r is BusinessLine => r.type === 'workline' && r.projectId === project.id && live(r),
      );
      const pointIds = new Set(
        records
          .filter((r) => r.type === 'milestone' && lines.some((l) => l.id === r.lineId))
          .map((r) => r.id),
      );
      const matches =
        !query ||
        [
          project,
          ...lines,
          ...records.filter(
            (r) => pointIds.has(r.id) || (r.type === 'todo' && pointIds.has(r.milestoneId)),
          ),
        ].some((r) => r.title.toLowerCase().includes(query));
      return { project, lines, matches };
    })
    .filter((group) => group.matches);
  const jump = (id: string) => {
    setActiveId(id);
    content.current
      ?.querySelector<HTMLElement>(`[data-space-id="${id}"]`)
      ?.scrollIntoView({ block: 'start', inline: 'nearest' });
  };
  const change = (r: SpaceItem, fields: object) =>
    run(async () => {
      await save(
        createRecord(r.type, { ...r, ...fields }),
        snapshot.entries.find((e) => e.data.id === r.id),
        'completedAt' in fields
          ? { completion: Boolean((fields as { completedAt: string | null }).completedAt) }
          : undefined,
      );
      await reload();
    });
  const toggle = (todo: Todo) =>
    change(todo, { completedAt: todo.completedAt ? null : new Date().toISOString() });
  const renderPoint = (point: Milestone) => (
    <article
      className={`milestone-point${point.pool ? ' todo-pool' : ''}${isComplete(point, snapshot.entries) ? ' milestone-done' : ''}`}
      key={point.id}
      data-space-id={point.id}
      aria-label={`关键节点 · ${point.title}`}
    >
      {!point.pool && (
        <>
          <button className="point-dates" aria-label={`调整日期 · ${point.title}`}>
            <span>
              截止 {point.dueDate ?? '未定'} {point.dueTime}
            </span>
          </button>
          <div className="point-marker-row">
            <button
              className={`point-dot priority-${point.importance}`}
              role="checkbox"
              aria-checked={isComplete(point, snapshot.entries)}
              aria-label={`完成节点 ${point.title}`}
              title={`${point.title} · ${importanceLabel(point.importance)}`}
              onClick={() =>
                change(point, {
                  completedAt: isComplete(point, snapshot.entries)
                    ? null
                    : new Date().toISOString(),
                })
              }
            >
              {isComplete(point, snapshot.entries) && <CheckIcon />}
            </button>
          </div>
        </>
      )}
      <button className="point-title" onClick={() => select(point.id)}>
        {point.title}
      </button>
      {point.tags.length > 0 && <small className="node-tags">{point.tags.join(' · ')}</small>}
      <TodoRows
        entries={snapshot.entries}
        todos={records.filter((r): r is Todo => r.type === 'todo' && r.milestoneId === point.id)}
        select={select}
        toggle={toggle}
      />
      <Button
        className="add-todo"
        onClick={() => edit({ type: 'todo', defaults: { milestoneId: point.id } })}
      >
        <PlusIcon />
        TODO
      </Button>
      <Button
        className="add-todo"
        onClick={() => edit({ type: 'todo', defaults: { milestoneId: point.id, kind: 'idea' } })}
      >
        <PlusIcon />
        IDEA
      </Button>
    </article>
  );
  return (
    <div className="space-board">
      <nav className="workspace-nav" aria-label="业务导航">
        <div className="workspace-nav-tree">
          <ul>
            {groups.map(({ project, lines }) => {
              const folded = collapsed.has(project.id);
              return (
                <li key={project.id} data-space-id={project.id}>
                  <div className="workspace-nav-project">
                    <button
                      className="workspace-nav-toggle"
                      aria-expanded={!folded}
                      aria-label={`${folded ? '展开' : '收缩'}项目 ${project.title}`}
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (folded) next.delete(project.id);
                          else next.add(project.id);
                          return next;
                        })
                      }
                    >
                      {folded ? <ChevronRightIcon /> : <ChevronDownIcon />}
                    </button>
                    <button
                      aria-current={activeId === project.id ? 'location' : undefined}
                      aria-label={`定位项目 · ${project.title}`}
                      onClick={() => jump(project.id)}
                      title={project.title}
                    >
                      <span>{project.title}</span>
                    </button>
                  </div>
                  {!folded && (
                    <ul>
                      {lines.map((line) => (
                        <li key={line.id} data-space-id={line.id}>
                          <button
                            aria-current={activeId === line.id ? 'location' : undefined}
                            aria-label={`定位业务线 · ${line.title}`}
                            onClick={() => jump(line.id)}
                            title={line.title}
                          >
                            <ImportanceDot value={line.importance} />
                            <span>{line.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="workspace-nav-actions">
          <label className="check-label">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => onShowArchivedChange(e.target.checked)}
            />
            显示已完成项目 / 业务线
          </label>
          <Button onClick={() => edit({ type: 'project' })}>
            <PlusIcon />
            新增项目
          </Button>
        </div>
      </nav>
      <div className="workspace-content" ref={content}>
        {!groups.length && <EmptyState>{query ? '没有匹配的工作' : '暂无项目'}</EmptyState>}
        {groups.map(({ project, lines }) => (
          <section
            className="project-plane"
            key={project.id}
            data-space-id={project.id}
            aria-label={`项目面 · ${project.title}`}
          >
            <div className="project-heading">
              <button className="project-title" onClick={() => select(project.id)}>
                <h2>{project.title}</h2>
              </button>
              <Button
                onClick={() => edit({ type: 'workline', defaults: { projectId: project.id } })}
              >
                <PlusIcon />
                业务线
              </Button>
            </div>
            <div className="plane-content">
              {lines.map((line) => {
                const points = records
                  .filter((r): r is Milestone => r.type === 'milestone' && r.lineId === line.id)
                  .sort(compareMilestones);
                return (
                  <section
                    className="business-track"
                    key={line.id}
                    data-space-id={line.id}
                    aria-label={`业务线 · ${line.title}`}
                  >
                    <div className="track-scroll">
                      <div className="track-points">
                        <div className={`track-nodes priority-${line.importance}`}>
                          <div className="line-origin">
                            <button
                              className="line-title"
                              onClick={() => select(line.id)}
                              title={line.title}
                            >
                              <strong>{line.title}</strong>
                            </button>
                            <button
                              className="line-importance"
                              aria-label={`编辑重要性 · ${line.title}`}
                            >
                              <ImportanceDot value={line.importance} />
                            </button>
                          </div>
                          {points.filter((point) => !point.pool).map(renderPoint)}
                          <button
                            className="add-point"
                            onClick={() =>
                              edit({ type: 'milestone', defaults: { lineId: line.id } })
                            }
                          >
                            <PlusIcon />
                            关键节点
                          </button>
                        </div>
                        {points.filter((point) => point.pool).map(renderPoint)}
                      </div>
                    </div>
                  </section>
                );
              })}
              {!lines.length && <p className="plane-empty">暂无业务线</p>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
