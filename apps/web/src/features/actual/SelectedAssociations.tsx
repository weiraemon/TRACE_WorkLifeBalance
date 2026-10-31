import type { Milestone, Todo } from '../../../../../packages/domain/index';
import { Button, Field } from '../../components/ui';
import type { ActualAssociations } from './useActualAssociations';

function AssociationComment({
  id,
  title,
  selection,
}: {
  id: string;
  title: string;
  selection: ActualAssociations;
}) {
  return (
    <details className="result-disclosure">
      <summary>成果 / 下一步 · {title}</summary>
      <Field label={`批注 · ${title}`}>
        <textarea
          rows={2}
          value={selection.comments[id]?.text ?? ''}
          onChange={(event) => selection.setComment(id, event.target.value)}
        />
      </Field>
    </details>
  );
}
function AssociationCompletion({
  item,
  selection,
}: {
  item: Milestone | Todo;
  selection: ActualAssociations;
}) {
  const children = item.type === 'milestone' ? selection.childCount(item.id) : 0;
  const inherited = item.type === 'todo' && selection.inheritedCompletion(item);
  return (
    <label className="association-completion" title={inherited ? '已随所属节点选择完成' : ''}>
      <input
        type="checkbox"
        aria-label={`${item.type === 'milestone' ? '本次完成节点' : '本次完成'} ${item.title}`}
        checked={selection.markedComplete(item)}
        disabled={selection.persistedComplete(item) || inherited}
        onChange={(event) => selection.setComplete(item.id, event.target.checked)}
      />
      本次完成{children > 0 && <small>（含下属 {children} 个条目）</small>}
    </label>
  );
}
export function SelectedAssociations({ selection }: { selection: ActualAssociations }) {
  if (!selection.selectedNodes.length && !selection.selectedItems.length) return null;
  return (
    <section className="actual-selected" aria-label="已选择">
      <h3>已添加</h3>
      {selection.selectedNodes.map((node) => (
        <div className="actual-item" key={node.id}>
          <div className="actual-selected-heading">
            <span>节点 · {node.title}</span>
            <Button type="button" onClick={() => selection.remove(node.id, 'milestone')}>
              移除
            </Button>
          </div>
          <AssociationCompletion item={node} selection={selection} />
          <AssociationComment id={node.id} title={node.title} selection={selection} />
        </div>
      ))}
      <div className="linked-todos" aria-label="已关联条目">
        {selection.selectedItems.map((context) => (
          <div className="actual-item" key={context.todo.id} data-space-id={context.todo.id}>
            <div className="actual-todo-choice">
              <span>
                {context.todo.kind.toUpperCase()} · {context.todo.title}
                <small>
                  {context.project.title} / {context.line.title} /{' '}
                  {context.milestone.pool ? '待办池' : context.milestone.title}
                </small>
              </span>
              <Button type="button" onClick={() => selection.remove(context.todo.id, 'todo')}>
                移除
              </Button>
              <AssociationCompletion item={context.todo} selection={selection} />
            </div>
            <AssociationComment
              id={context.todo.id}
              title={context.todo.title}
              selection={selection}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
