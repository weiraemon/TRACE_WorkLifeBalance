import { useRef, useState } from 'react';
import {
  PlusIcon,
  CheckIcon,
  ChatBubbleIcon,
  TargetIcon,
  FileTextIcon,
  CheckCircledIcon,
  BookmarkIcon,
  MixerHorizontalIcon,
} from '@radix-ui/react-icons';
import {
  isSpaceItem,
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
import { WorkspaceNavigation, workspaceGroups } from './WorkspaceNavigation';
import { useWorkspaceDrag } from './useWorkspaceDrag';
const tagIcons: Record<string, typeof ChatBubbleIcon> = {
  会议: ChatBubbleIcon,
  报告: FileTextIcon,
  专注: TargetIcon,
  实验: MixerHorizontalIcon,
  讨论: ChatBubbleIcon,
  审阅: CheckCircledIcon,
};
function NodeTagIcon({ tag }: { tag: string }) {
  const Icon = tagIcons[tag] ?? BookmarkIcon;
  return <Icon aria-hidden="true" />;
}
export function TodoRows({
  todos,
  entries,
  select,
  toggle,
  drag,
}: {
  todos: Todo[];
  entries: Entry[];
  select?: (id: string) => void;
  toggle?: (todo: Todo) => void;
  drag?: ReturnType<typeof useWorkspaceDrag>;
}) {
  return (
    <ul className="todo-rows">
      {todos.map((todo) => {
        const done = isComplete(todo, entries);
        return (
          <li
            key={todo.id}
            data-space-id={todo.id}
            className={done ? 'todo-done' : ''}
            {...drag?.targetProps(todo.id)}
          >
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
                <button
                  className="todo-title"
                  onClick={() => select(todo.id)}
                  {...drag?.sourceProps(todo)}
                >
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
  const [activeId, setActiveId] = useState('');
  const content = useRef<HTMLDivElement>(null);
  const drag = useWorkspaceDrag(snapshot, reload, run);
  const records = snapshot.entries
    .map((e) => e.data)
    .filter(isSpaceItem)
    .sort(
      (a, b) =>
        a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  const groups = workspaceGroups(snapshot.entries, showArchived, query);
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
      {...drag.targetProps(point.id)}
      aria-label={`关键节点 · ${point.title}`}
    >
      {!point.pool && (
        <>
          <div className="point-meta">
            <small className="node-tags" title={point.tags.join(' · ')}>
              {point.tags.join(' · ')}
            </small>
            {point.location && <small className="node-location">{point.location}</small>}
            <button className="point-dates" aria-label={`调整日期 · ${point.title}`}>
              <span>
                截止 {point.dueDate ?? '未定'} {point.dueTime}
              </span>
            </button>
          </div>
          <div className="point-marker-row">
            <button
              className={`point-dot priority-${point.importance}${point.tags.length ? ' node-tagged' : ''}`}
              role="checkbox"
              aria-checked={isComplete(point, snapshot.entries)}
              aria-label={`完成节点 ${point.title}`}
              title={`${point.title} · ${point.tags.join(' · ')} · ${importanceLabel(point.importance)}`}
              onClick={() =>
                change(point, {
                  completedAt: isComplete(point, snapshot.entries)
                    ? null
                    : new Date().toISOString(),
                })
              }
            >
              {isComplete(point, snapshot.entries) ? (
                <CheckIcon />
              ) : point.tags[0] ? (
                <NodeTagIcon tag={point.tags[0]} />
              ) : null}
            </button>
          </div>
        </>
      )}
      <button
        className="point-title"
        onClick={() => select(point.id)}
        {...(!point.pool && drag.sourceProps(point))}
      >
        {point.title}
      </button>
      <TodoRows
        entries={snapshot.entries}
        todos={records.filter((r): r is Todo => r.type === 'todo' && r.milestoneId === point.id)}
        select={select}
        toggle={toggle}
        drag={drag}
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
      <WorkspaceNavigation
        groups={groups}
        activeId={activeId}
        onSelect={jump}
        showArchived={showArchived}
        onShowArchivedChange={onShowArchivedChange}
        onCreateProject={() => edit({ type: 'project' })}
      />
      <div className="workspace-content" ref={content} {...drag.boardProps}>
        <p className="workspace-drag-status" role="status">
          {drag.status}
        </p>
        {!groups.length && <EmptyState>{query ? '没有匹配的工作' : '暂无项目'}</EmptyState>}
        {groups.map(({ project, lines }) => (
          <section
            className="project-plane"
            key={project.id}
            data-space-id={project.id}
            {...drag.targetProps(project.id)}
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
                    {...drag.targetProps(line.id)}
                    aria-label={`业务线 · ${line.title}`}
                  >
                    <div className="track-scroll">
                      <div className="track-points">
                        <div className={`track-nodes priority-${line.importance}`}>
                          <div className="line-origin">
                            <button
                              className="line-title"
                              onClick={() => select(line.id)}
                              {...drag.sourceProps(line)}
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
