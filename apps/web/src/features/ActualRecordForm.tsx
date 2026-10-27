import { useState } from 'react';
import {
  clock,
  localDay,
  type Snapshot,
  type Todo,
  type Milestone,
  type Project,
} from '../../../../packages/domain/index';
import {
  activeLines,
  compareMilestones,
  todoContexts,
} from '../../../../packages/domain/workspace';
import { createRecord, save } from '../api';
import { Modal, Field, Button, ErrorMessage, DatePicker } from '../components/ui';
import type { Editor } from './editor';
import { QuickCapture } from './QuickCapture';
export function ActualRecordForm({
  editor,
  snapshot,
  close,
  reload,
  embedded = false,
}: {
  editor: Editor;
  snapshot: Snapshot;
  close: () => void;
  reload: () => Promise<void>;
  embedded?: boolean;
}) {
  const old = editor.entry?.data.type === 'actual' ? editor.entry.data : undefined;
  const now = new Date(),
    minute = Math.min(1439, now.getHours() * 60 + now.getMinutes());
  const [id] = useState(() => old?.id ?? crypto.randomUUID());
  const [startTime, setStart] = useState(
    old?.startTime ?? String(editor.defaults?.startTime ?? clock(Math.max(0, minute - 30))),
  );
  const [endTime, setEnd] = useState(
    old?.endTime ?? String(editor.defaults?.endTime ?? clock(minute || 1)),
  );
  const [description, setDescription] = useState(old?.description ?? '');
  const [date, setDate] = useState(old?.date ?? String(editor.defaults?.date ?? localDay()));
  const [milestoneIds, setMilestoneIds] = useState<string[]>(old?.milestoneIds ?? []);
  const [linked, setLinked] = useState<string[]>(old?.itemIds ?? []);
  const [completed, setCompleted] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Todo[]>([]);
  const [comments, setComments] = useState<Record<string, { id: string; text: string }>>({});
  const [showNewCapture, setShowNewCapture] = useState(false);
  const [associationFilter, setAssociationFilter] = useState({
    projectId: '',
    lineId: '',
    nodeId: '',
  });
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const virtual = [
    ...snapshot.entries,
    ...drafts.map((data) => ({ data, path: '', revision: '' })),
  ];
  const contexts = todoContexts(virtual);
  const selected = contexts.filter((c) => linked.includes(c.todo.id));
  const availableContexts = contexts.filter(
    (c) => !c.todo.completedAt && !c.line.completedAt && !c.project.completedAt,
  );
  const lines = activeLines(snapshot.entries);
  const linesById = new Map(lines.map((line) => [line.id, line]));
  const projects = snapshot.entries
    .map((e) => e.data)
    .filter((r): r is Project => r.type === 'project' && !r.completedAt);
  const nodes = snapshot.entries
    .map((e) => e.data)
    .filter((r): r is Milestone => r.type === 'milestone' && !r.pool);
  const selectedNodes = nodes.filter((node) => milestoneIds.includes(node.id));
  const candidateNodes = nodes
    .filter((node) => {
      const line = linesById.get(node.lineId);
      return (
        line &&
        (!associationFilter.projectId || line.projectId === associationFilter.projectId) &&
        (!associationFilter.lineId || line.id === associationFilter.lineId) &&
        (!associationFilter.nodeId || node.id === associationFilter.nodeId)
      );
    })
    .sort(compareMilestones);
  const nodeChoices = candidateNodes.filter((node) => !milestoneIds.includes(node.id));
  const todoChoices = availableContexts
    .filter(
      (c) =>
        (!associationFilter.projectId || c.project.id === associationFilter.projectId) &&
        (!associationFilter.lineId || c.line.id === associationFilter.lineId) &&
        (!associationFilter.nodeId || c.milestone.id === associationFilter.nodeId) &&
        !linked.includes(c.todo.id),
    )
    .sort(
      (a, b) =>
        Number(b.milestone.pool) - Number(a.milestone.pool) ||
        compareMilestones(a.milestone, b.milestone) ||
        a.todo.title.localeCompare(b.todo.title),
    );
  const commentField = (targetId: string, title: string) => (
    <Field label={`批注 · ${title}`}>
      <textarea
        rows={2}
        value={comments[targetId]?.text ?? ''}
        onChange={(e) =>
          setComments((values) => ({
            ...values,
            [targetId]: { id: values[targetId]?.id ?? crypto.randomUUID(), text: e.target.value },
          }))
        }
      />
    </Field>
  );
  const form = (
    <form
      aria-label="实际工作录入"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await save(
            createRecord('actual', {
              ...(old ?? {}),
              id,
              date,
              startTime,
              endTime,
              description,
              itemIds: linked,
              milestoneIds,
            }),
            editor.entry,
            {
              newItems: drafts.filter((r) => linked.includes(r.id)),
              completeIds: completed.filter((target) => linked.includes(target)),
              comments: Object.entries(comments)
                .filter(
                  ([target, value]) =>
                    (linked.includes(target) || milestoneIds.includes(target)) && value.text.trim(),
                )
                .map(([targetId, value]) => ({ ...value, targetId, date })),
            },
          );
          await reload();
          close();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="具体事件">
        <textarea
          required
          autoFocus={!embedded}
          rows={2}
          placeholder="写下这段时间具体做了什么…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="actual-time-fields">
        <Field label="记录日期">
          <DatePicker value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </Field>
        <Field label="开始时间">
          <input
            type="time"
            required
            value={startTime}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="结束时间">
          <input
            required
            pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00"
            value={endTime}
            onChange={(e) => setEnd(e.target.value)}
          />
        </Field>
      </div>
      <section className="actual-pool" aria-label="待选池">
        <h3>待选池</h3>
        <p className="hint">按项目、业务线和节点缩小范围，再把节点或待办加入本次记录。</p>
        <div className="form-grid">
          <Field label="项目">
            <select
              value={associationFilter.projectId}
              onChange={(e) => {
                setAssociationFilter({ projectId: e.target.value, lineId: '', nodeId: '' });
              }}
            >
              <option value="">所有项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="业务线">
            <select
              value={associationFilter.lineId}
              onChange={(e) => {
                setAssociationFilter((filter) => ({
                  ...filter,
                  lineId: e.target.value,
                  nodeId: '',
                }));
              }}
            >
              <option value="">所有业务线</option>
              {lines
                .filter(
                  (line) =>
                    !associationFilter.projectId || line.projectId === associationFilter.projectId,
                )
                .map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.title}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="节点">
            <select
              value={associationFilter.nodeId}
              onChange={(e) => {
                setAssociationFilter((filter) => ({ ...filter, nodeId: e.target.value }));
              }}
            >
              <option value="">所有节点</option>
              {candidateNodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {linesById.get(node.lineId)?.title} · {node.title}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="actual-pool-choices">
          {nodeChoices.map((node) => (
            <div className="actual-pool-choice" key={node.id}>
              <span>
                节点 · {node.title}
                <small>{linesById.get(node.lineId)?.title}</small>
              </span>
              <Button type="button" onClick={() => setMilestoneIds((ids) => [...ids, node.id])}>
                加入
              </Button>
            </div>
          ))}
          {todoChoices.map((c) => (
            <div className="actual-pool-choice" key={c.todo.id}>
              <span>
                {c.todo.kind.toUpperCase()} · {c.todo.title}
                <small>
                  {c.project.title} / {c.line.title} /{' '}
                  {c.milestone.pool ? '待办池' : c.milestone.title}
                </small>
              </span>
              <Button type="button" onClick={() => setLinked((ids) => [...ids, c.todo.id])}>
                加入
              </Button>
            </div>
          ))}
          {nodeChoices.length === 0 && todoChoices.length === 0 && (
            <p className="hint">没有可选内容</p>
          )}
        </div>
      </section>
      <section className="actual-selected" aria-label="已选择">
        <h3>已选择</h3>
        {selectedNodes.length === 0 && selected.length === 0 && (
          <p className="hint">尚未关联节点或待办</p>
        )}
        {selectedNodes.map((node) => (
          <div className="actual-item" key={node.id}>
            <div className="actual-selected-heading">
              <span>节点 · {node.title}</span>
              <Button
                type="button"
                onClick={() => setMilestoneIds((ids) => ids.filter((id) => id !== node.id))}
              >
                移除
              </Button>
            </div>
            {commentField(node.id, node.title)}
          </div>
        ))}
        <div className="linked-todos" aria-label="已关联条目">
          {selected.map((c) => (
            <div className="actual-item" key={c.todo.id} data-space-id={c.todo.id}>
              <div className="actual-todo-choice">
                <span>
                  {c.todo.kind.toUpperCase()} · {c.todo.title}
                  <small>
                    {c.project.title} / {c.line.title} /{' '}
                    {c.milestone.pool ? '待办池' : c.milestone.title}
                  </small>
                </span>
                <Button
                  type="button"
                  onClick={() => {
                    setLinked((ids) => ids.filter((target) => target !== c.todo.id));
                    setCompleted((ids) => ids.filter((target) => target !== c.todo.id));
                  }}
                >
                  移除
                </Button>
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(c.todo.completedAt) || completed.includes(c.todo.id)}
                    disabled={Boolean(c.todo.completedAt)}
                    aria-label={`本次完成 ${c.todo.title}`}
                    onChange={(e) =>
                      setCompleted((ids) =>
                        e.target.checked
                          ? [...ids, c.todo.id]
                          : ids.filter((target) => target !== c.todo.id),
                      )
                    }
                  />
                  本次完成
                </label>
              </div>
              {commentField(c.todo.id, c.todo.title)}
            </div>
          ))}
        </div>
      </section>
      <ErrorMessage message={error} />
      <div className="form-actions">
        <Button type="button" onClick={close}>
          {embedded ? '清空' : '取消'}
        </Button>
        <Button type="submit" className="primary" disabled={busy}>
          {busy ? '正在保存…' : '保存实际工作'}
        </Button>
      </div>
      <section className="actual-new-items" aria-label="新建 TODO / IDEA">
        <Button type="button" onClick={() => setShowNewCapture((show) => !show)}>
          {showNewCapture ? '收起新建 TODO / IDEA' : '新建 TODO / IDEA'}
        </Button>
        {showNewCapture && (
          <>
            {drafts.length > 0 && (
              <p className="hint actual-new-items-count">
                本次已新增 {drafts.length} 条 TODO / IDEA，可以继续添加。
              </p>
            )}
            <QuickCapture
              snapshot={snapshot}
              key={associationFilter.lineId}
              defaultLineId={associationFilter.lineId}
              allowMilestone={false}
              today={date}
              onCreate={async (item, comment) => {
                if (item.type !== 'todo') throw new Error('实际工作中的快速收集仅支持 TODO / IDEA');
                setDrafts((items) => [...items, item]);
                setLinked((ids) => [...ids, item.id]);
                if (comment.trim())
                  setComments((values) => ({
                    ...values,
                    [item.id]: { id: crypto.randomUUID(), text: comment },
                  }));
              }}
            />
          </>
        )}
      </section>
    </form>
  );
  return embedded ? (
    form
  ) : (
    <Modal title={`${old ? '编辑' : '记录'}实际工作 · ${date}`} onClose={close}>
      {form}
    </Modal>
  );
}
