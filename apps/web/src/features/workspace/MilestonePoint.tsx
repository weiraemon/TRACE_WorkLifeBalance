import { PlusIcon, CheckIcon } from '@radix-ui/react-icons';
import type { Milestone, Snapshot, Todo } from '../../../../../packages/domain/index';
import { isComplete } from '../../../../../packages/domain/workspace';
import { Button } from '../../components/ui';
import { importanceLabel } from '../../components/Importance';
import type { Editor } from '../../types/editor';
import type { useWorkspaceDrag } from './useWorkspaceDrag';
import { TodoRows } from './TodoRows';
import { NodeTagIcon } from './NodeTagIcon';
export type MilestonePointProps = {
  point: Milestone;
  snapshot: Snapshot;
  todos: Todo[];
  select: (id: string) => void;
  edit: (editor: Editor) => void;
  toggle: (item: Todo | Milestone) => void;
  drag: ReturnType<typeof useWorkspaceDrag>;
};
export function MilestonePoint({
  point,
  snapshot,
  todos,
  select,
  edit,
  toggle,
  drag,
}: MilestonePointProps) {
  const done = isComplete(point, snapshot.entries);
  return (
    <article
      className={`milestone-point${point.pool ? ' todo-pool' : ''}${done ? ' milestone-done' : ''}`}
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
              aria-checked={done}
              aria-label={`完成节点 ${point.title}`}
              title={`${point.title} · ${point.tags.join(' · ')} · ${importanceLabel(point.importance)}`}
              onClick={() => toggle(point)}
            >
              {point.tags[0] ? <NodeTagIcon tag={point.tags[0]} /> : done ? <CheckIcon /> : null}
              {done && point.tags[0] && <CheckIcon className="node-completion-mark" />}
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
        todos={todos}
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
}
