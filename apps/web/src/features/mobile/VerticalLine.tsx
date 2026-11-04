import { useRef, useState } from 'react';
import {
  CheckIcon,
  DotsHorizontalIcon,
  PlusIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from '@radix-ui/react-icons';
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
import type { Editor } from '../../types/editor';

export function VerticalLine({
  snapshot,
  line,
  lines,
  changeLine,
  select,
  edit,
  toggle,
  actions,
}: {
  snapshot: Snapshot;
  line: BusinessLine;
  lines: BusinessLine[];
  changeLine: (id: string) => void;
  select: (id: string) => void;
  edit: (editor: Editor) => void;
  toggle: (id: string) => void;
  actions: (id: string) => void;
}) {
  const [older, setOlder] = useState(false);
  const gesture = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const index = lines.findIndex((item) => item.id === line.id);
  const change = (direction: number) => {
    const next = lines[index + direction];
    if (next) changeLine(next.id);
  };
  const visible = (item: Milestone | Todo) =>
    older || !shouldHideCompleted(item, snapshot.entries, localDay());
  const points = snapshot.entries
    .map((entry) => entry.data)
    .filter(
      (item): item is Milestone =>
        item.type === 'milestone' && item.lineId === line.id && visible(item),
    )
    .sort(compareMilestones);
  return (
    <section
      className="mobile-line-page"
      aria-label={`业务线 · ${line.title}`}
      onPointerDown={(event) => {
        suppressClick.current = false;
        if ((event.target as Element).closest('input, textarea, select, a')) return;
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
    >
      <div className="mobile-line-switcher">
        <Button disabled={index <= 0} aria-label="上一条业务线" onClick={() => change(-1)}>
          <ChevronLeftIcon />
        </Button>
        <span aria-live="polite">
          {index + 1} / {lines.length} · 左右滑动切换
        </span>
        <Button
          disabled={index >= lines.length - 1}
          aria-label="下一条业务线"
          onClick={() => change(1)}
        >
          <ChevronRightIcon />
        </Button>
      </div>
      <div className="mobile-line-title">
        <h1>{line.title}</h1>
        <Button aria-label={`业务线操作 · ${line.title}`} onClick={() => actions(line.id)}>
          <DotsHorizontalIcon />
        </Button>
      </div>
      <label className="mobile-show-older">
        <input
          type="checkbox"
          checked={older}
          onChange={(event) => setOlder(event.target.checked)}
        />
        显示较早完成的内容
      </label>
      <div className="mobile-vertical-track">
        {points.map((point) => {
          const done = isComplete(point, snapshot.entries);
          const todos = snapshot.entries
            .map((entry) => entry.data)
            .filter(
              (item): item is Todo =>
                item.type === 'todo' && item.milestoneId === point.id && visible(item),
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
              <div className="mobile-node-meta">
                {point.pool ? (
                  <span>未安排期限</span>
                ) : (
                  <>
                    <button
                      aria-label={`调整日期 · ${point.title}`}
                      onClick={() => actions(point.id)}
                    >
                      {point.dueDate ?? '日期未定'}
                      {point.dueTime && <strong>{point.dueTime}</strong>}
                    </button>
                    <span>{point.tags.join(' · ')}</span>
                    {point.location && <span>{point.location}</span>}
                  </>
                )}
                <div className="mobile-node-tools">
                  {!point.pool && (
                    <Button
                      aria-label={`节点操作 · ${point.title}`}
                      onClick={() => actions(point.id)}
                    >
                      <DotsHorizontalIcon />
                    </Button>
                  )}
                  <Button
                    onClick={() => edit({ type: 'todo', defaults: { milestoneId: point.id } })}
                  >
                    <PlusIcon />
                    待办
                  </Button>
                  <Button
                    onClick={() =>
                      edit({ type: 'todo', defaults: { milestoneId: point.id, kind: 'idea' } })
                    }
                  >
                    <PlusIcon />
                    想法
                  </Button>
                </div>
              </div>
              <div className="mobile-node-axis">
                {point.pool ? (
                  <span className="mobile-pool-dot" />
                ) : (
                  <button
                    className={`mobile-node-dot priority-${point.importance}`}
                    role="checkbox"
                    aria-checked={done}
                    aria-label={`完成节点 ${point.title}`}
                    onClick={() => toggle(point.id)}
                  >
                    {done ? (
                      <CheckIcon />
                    ) : point.tags[0] ? (
                      <NodeTagIcon tag={point.tags[0]} />
                    ) : (
                      <span />
                    )}
                  </button>
                )}
              </div>
              <div className="mobile-node-content">
                <div className="mobile-node-heading">
                  <button
                    className={done ? 'mobile-completed' : ''}
                    onClick={() => select(point.id)}
                  >
                    {point.title}
                  </button>
                </div>
                <ul className="mobile-todos">
                  {todos.map((todo) => {
                    const completed = isComplete(todo, snapshot.entries);
                    return (
                      <li key={todo.id} data-space-id={todo.id}>
                        <button
                          className={`mobile-todo-check priority-${todo.importance}`}
                          role="checkbox"
                          aria-checked={completed}
                          aria-label={`完成 ${todo.title}`}
                          onClick={() => toggle(todo.id)}
                        >
                          {completed && <CheckIcon />}
                        </button>
                        <button
                          className={`mobile-todo-title${completed ? ' mobile-completed' : ''}`}
                          onClick={() => select(todo.id)}
                        >
                          {todo.kind === 'idea' && <small>IDEA</small>}
                          {todo.title}
                          {(todo.dueDate || todo.direction !== 'self') && (
                            <small>
                              {todo.dueDate}
                              {todo.direction !== 'self'
                                ? ` · ${todo.direction === 'from' ? '等' : '找'} ${todo.person}`
                                : ''}
                            </small>
                          )}
                        </button>
                        <Button
                          aria-label={`条目操作 · ${todo.title}`}
                          onClick={() => actions(todo.id)}
                        >
                          <DotsHorizontalIcon />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </article>
          );
        })}
      </div>
      <Button
        className="mobile-primary-add"
        onClick={() => edit({ type: 'milestone', defaults: { lineId: line.id } })}
      >
        <PlusIcon />
        添加节点
      </Button>
    </section>
  );
}
