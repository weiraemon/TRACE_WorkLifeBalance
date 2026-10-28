import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  parseRecord,
  validateChange,
  timeTotals,
  type Entry,
  type RecordData,
} from '../packages/domain/index';
import {
  isComplete,
  lineFor,
  todoContexts,
  todosForDay,
  milestonesForDay,
  overdueMilestones,
  spaceSubtree,
} from '../packages/domain/workspace';
const make = (type: string, fields: object = {}) =>
  parseRecord({
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: '2026-10-25T00:00:00Z',
    updatedAt: '2026-10-25T00:00:00Z',
    type,
    ...fields,
  });
const entry = (data: RecordData): Entry => ({ data, path: '', revision: '' });
function setup() {
  const project = make('project', { title: '项目' });
  const line = make('workline', { title: '论文', projectId: project.id });
  const node = make('milestone', {
    title: '讨论',
    lineId: line.id,
    dueDate: '2026-10-25',
    dueTime: '09:00',
  });
  return { project, line, node, entries: [project, line, node].map(entry) };
}
it('TODO 与 IDEA 同属任意具体节点，逐层推导归属且不能跨层挂载', () => {
  const { project, line, node, entries } = setup();
  const todo = make('todo', { title: '要材料', milestoneId: node.id });
  const idea = make('todo', { title: '新假设', kind: 'idea', milestoneId: node.id });
  const all = [...entries, entry(todo), entry(idea)];
  expect(todoContexts(all).map((c) => c.todo.id)).toEqual([todo.id, idea.id]);
  expect(lineFor(idea, all)?.id).toBe(line.id);
  expect(spaceSubtree(all, project.id)).toHaveLength(5);
  expect(() => validateChange(make('todo', { ...todo, milestoneId: line.id }), all)).toThrow(
    '跨层级',
  );
  expect(() =>
    validateChange(make('todo', { ...idea, direction: 'from', person: '甲' }), all),
  ).toThrow('IDEA');
});
it('条目全部完成则节点完成，但空节点、池、业务线与项目不被连带完成', () => {
  const { project, line, node, entries } = setup();
  const todo = make('todo', {
    title: '行动',
    milestoneId: node.id,
    completedAt: '2026-10-25T01:00:00Z',
  });
  const idea = make('todo', { title: '验证想法', kind: 'idea', milestoneId: node.id });
  expect(isComplete(node, [...entries, entry(todo), entry(idea)])).toBe(false);
  const doneIdea = make('todo', { ...idea, completedAt: '2026-10-25T02:00:00Z' });
  const all = [...entries, entry(todo), entry(doneIdea)];
  expect(isComplete(node, all)).toBe(true);
  expect(isComplete(line, all)).toBe(false);
  expect(isComplete(project, all)).toBe(false);
  expect(isComplete(node, entries)).toBe(false);
  expect(
    isComplete(make('milestone', { ...node, dueDate: null, dueTime: null, pool: true }), all),
  ).toBe(false);
});
it('实际关联只表达推进，不自动完成，重复和不存在关联被拒绝，多条目仍只计一次时长', () => {
  const { node, entries } = setup();
  const todo = make('todo', { title: '行动', milestoneId: node.id });
  const idea = make('todo', { title: '探索', milestoneId: node.id, kind: 'idea' });
  const actual = make('actual', {
    date: '2026-10-25',
    startTime: '09:00',
    endTime: '10:00',
    description: '做实验',
    itemIds: [todo.id, idea.id],
  });
  const all = [...entries, entry(todo), entry(idea), entry(actual)];
  validateChange(actual, all);
  expect(isComplete(todo, all)).toBe(false);
  expect(timeTotals(all, '2026-10-25', '2026-10-25')).toEqual({
    total: 60,
    projects: { 项目: 60 },
  });
  expect(() =>
    validateChange(make('actual', { ...actual, itemIds: [todo.id, todo.id] }), all),
  ).toThrow('重复');
  expect(() => validateChange(make('actual', { ...actual, itemIds: [randomUUID()] }), all)).toThrow(
    '不存在',
  );
});
it('今日只含当天条目，完成权重为零；节点计划不包含池、不伪造时刻', () => {
  const { line, node, entries } = setup();
  const done = make('todo', {
    title: '已完成',
    milestoneId: node.id,
    importance: 5,
    completedAt: '2026-10-25T01:00:00Z',
  });
  const open = make('todo', { title: '要做', milestoneId: node.id, importance: 1 });
  const future = make('todo', { title: '明天', milestoneId: node.id, dueDate: '2026-10-26' });
  const pool = make('milestone', { title: '待办池', lineId: line.id, pool: true });
  const unscheduled = make('todo', { title: '收集想法', kind: 'idea', milestoneId: pool.id });
  const all = [...entries, ...[done, open, future, pool, unscheduled].map(entry)];
  expect(todosForDay(all, '2026-10-25').map((c) => c.todo.id)).toEqual([open.id, done.id]);
  expect(milestonesForDay(all, '2026-10-25').map((c) => c.milestone.id)).toEqual([node.id]);
});
it('过期事件只列出未完成、非待办池且归属仍有效业务线的过期节点', () => {
  const { project, line, node, entries } = setup();
  const completed = make('milestone', {
    title: '已结束事件',
    lineId: line.id,
    dueDate: '2026-10-24',
    completedAt: '2026-10-25T01:00:00Z',
  });
  const pool = make('milestone', {
    title: '待办池',
    lineId: line.id,
    pool: true,
  });
  const closedLine = make('workline', {
    title: '已结束业务线',
    projectId: project.id,
    completedAt: '2026-10-25T00:00:00Z',
  });
  const closedNode = make('milestone', {
    title: '已结束线上的事件',
    lineId: closedLine.id,
    dueDate: '2026-10-24',
  });
  const all = [...entries, ...[completed, pool, closedLine, closedNode].map(entry)];
  expect(overdueMilestones(all, '2026-10-27').map(({ milestone }) => milestone.id)).toEqual([
    node.id,
  ]);
});
it('严格拒绝旧状态、预计时长、旧实际历史与旧关联字段，不保留兼容分支', () => {
  const { node } = setup();
  for (const fields of [{ status: 'Ready' }, { estimatedMinutes: 30 }, { description: '旧说明' }])
    expect(() => make('todo', { title: '条目', milestoneId: node.id, ...fields })).toThrow();
  for (const fields of [{ history: [] }, { completedTodoIds: [] }, { workedTodoIds: [] }])
    expect(() =>
      make('actual', {
        date: '2026-10-25',
        startTime: '09:00',
        endTime: '10:00',
        description: '工作',
        ...fields,
      }),
    ).toThrow();
});
