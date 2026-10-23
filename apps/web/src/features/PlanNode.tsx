import { useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from '@radix-ui/react-icons';
import type { Snapshot, Todo } from '../../../../packages/domain/index';
import type { MilestoneContext } from '../../../../packages/domain/workspace';
import { ImportanceDot } from '../components/Importance';
import { TodoRows } from './WorkspaceBoard';
export function PlanNode({
  context,
  snapshot,
  timeLabel,
  goWorkspace,
}: {
  context: MilestoneContext;
  snapshot: Snapshot;
  timeLabel: string;
  goWorkspace: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { milestone, project } = context;
  const todos = snapshot.entries
    .map((e) => e.data)
    .filter(
      (r): r is Todo =>
        r.type === 'todo' && r.milestoneId === milestone.id && r.status !== 'Cancelled',
    )
    .sort(
      (a, b) =>
        a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  return (
    <div
      className={`scheduled-plan priority-${milestone.importance}${expanded ? ' plan-expanded' : ''}${milestone.status === 'Done' ? ' plan-done' : ''}`}
    >
      <button
        className="plan-node-toggle"
        aria-label={`${expanded ? '收起' : '展开'}节点待办 · ${milestone.title}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        title={`${project.title} / ${milestone.title} · ${timeLabel}`}
      >
        {expanded ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        <span className="plan-node-text">
          <span>{milestone.title}</span>
          <small>{timeLabel}</small>
        </span>
        <ImportanceDot value={milestone.importance} />
      </button>
      {expanded && (
        <div className="plan-todo-column" aria-label={`${milestone.title}的待办`}>
          <button
            className="plan-open"
            onClick={() => goWorkspace(milestone.id)}
            title={project.title}
          >
            查看节点 ↗
          </button>
          {todos.length ? (
            <TodoRows todos={todos} entries={snapshot.entries} select={goWorkspace} />
          ) : (
            <p className="hint">暂无待办</p>
          )}
        </div>
      )}
    </div>
  );
}
