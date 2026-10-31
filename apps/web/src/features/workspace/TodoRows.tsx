import { CheckIcon } from '@radix-ui/react-icons';
import type { Todo, Entry } from '../../../../../packages/domain/index';
import { isComplete } from '../../../../../packages/domain/workspace';
import type { useWorkspaceDrag } from './useWorkspaceDrag';
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
