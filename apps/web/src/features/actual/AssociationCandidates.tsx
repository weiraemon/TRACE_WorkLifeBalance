import { isComplete } from '../../../../../packages/domain/workspace';
import { useState } from 'react';
import type { Snapshot } from '../../../../../packages/domain/index';
import { activeLines, compareMilestones } from '../../../../../packages/domain/workspace';
import { Button } from '../../components/ui';
import type { ActualAssociations } from './useActualAssociations';

export function AssociationCandidates({
  snapshot,
  selection,
  date,
  lineId,
  setLineId,
}: {
  snapshot: Snapshot;
  selection: ActualAssociations;
  date: string;
  lineId: string;
  setLineId: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const lines = activeLines(snapshot.entries);
  const lineMap = new Map(lines.map((line) => [line.id, line]));
  const records = new Map(snapshot.entries.map((entry) => [entry.data.id, entry.data]));
  const query = search.trim().toLocaleLowerCase();
  const matches = (text: string) => !query || text.toLocaleLowerCase().includes(query);
  const nodes = selection.nodes
    .filter((node) => {
      const line = lineMap.get(node.lineId);
      const project = line ? records.get(line.projectId) : undefined;
      return (
        line &&
        records.get(node.id)?.type === 'milestone' &&
        !isComplete(node, snapshot.entries) &&
        project?.type === 'project' &&
        !project.completedAt &&
        !isComplete(line, snapshot.entries) &&
        (!lineId || line.id === lineId) &&
        !selection.milestoneIds.includes(node.id) &&
        matches(`${project && 'title' in project ? project.title : ''} ${line.title} ${node.title}`)
      );
    })
    .sort(
      (a, b) => Number(b.dueDate === date) - Number(a.dueDate === date) || compareMilestones(a, b),
    );
  const todos = selection.contexts
    .filter(
      (context) =>
        !isComplete(context.todo, snapshot.entries) &&
        !isComplete(context.line, snapshot.entries) &&
        !isComplete(context.project, snapshot.entries) &&
        (!lineId || context.line.id === lineId) &&
        !selection.itemIds.includes(context.todo.id) &&
        matches(
          `${context.project.title} ${context.line.title} ${context.milestone.title} ${context.todo.title}`,
        ),
    )
    .sort(
      (a, b) =>
        Number((b.todo.dueDate ?? b.milestone.dueDate) === date) -
          Number((a.todo.dueDate ?? a.milestone.dueDate) === date) ||
        Number(a.milestone.pool) - Number(b.milestone.pool) ||
        compareMilestones(a.milestone, b.milestone) ||
        a.todo.title.localeCompare(b.todo.title),
    );
  return (
    <section className="actual-pool" aria-label="待选池">
      <div className="actual-pool-header">
        <h3>待添加</h3>
        <input
          type="search"
          aria-label="搜索待选池"
          placeholder="搜索项目、业务线、节点或待办"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <select
        className="line-dropdown"
        aria-label="业务线"
        value={lineId}
        onChange={(event) => setLineId(event.target.value)}
      >
        <option value="">所有业务线</option>
        {lines.map((line) => (
          <option key={line.id} value={line.id}>
            {line.title}
          </option>
        ))}
      </select>
      <div className="actual-pool-choices">
        {nodes.map((node) => (
          <div className="actual-pool-choice" key={node.id}>
            <span>
              节点 · {node.title}
              <small>{lineMap.get(node.lineId)?.title}</small>
            </span>
            <Button type="button" onClick={() => selection.addNode(node.id)}>
              加入
            </Button>
          </div>
        ))}
        {todos.map((context) => (
          <div className="actual-pool-choice" key={context.todo.id}>
            <span>
              {context.todo.kind.toUpperCase()} · {context.todo.title}
              <small>
                {context.project.title} / {context.line.title} /{' '}
                {context.milestone.pool ? '待办池' : context.milestone.title}
              </small>
            </span>
            <Button type="button" onClick={() => selection.addItem(context.todo.id)}>
              加入
            </Button>
          </div>
        ))}
        {!nodes.length && !todos.length && <p className="hint">没有可选内容</p>}
      </div>
    </section>
  );
}
