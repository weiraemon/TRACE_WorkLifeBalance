import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  parseRecord,
  validateChange,
  timeTotals,
  type Entry,
  type RecordData,
  type Milestone,
} from '../packages/domain/index';
import {
  compareMilestones,
  todoContexts,
  todoStatus,
  milestonesForDay,
  milestoneTimeOnDay,
  contactGroups,
  dueLabel,
  todosForDay,
  contactsForDay,
} from '../packages/domain/workspace';
const make = (type: string, fields: object = {}) =>
  parseRecord({
    schemaVersion: 1,
    id: randomUUID(),
    type,
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
    ...fields,
  });
const entry = (data: RecordData): Entry => ({ data, path: '', revision: '' });
const setup = () => {
  const project = make('project', { title: '项目 A' });
  const line = make('workline', { title: '报告', projectId: project.id, kind: 'report' });
  const milestone = make('milestone', {
    title: '审阅',
    lineId: line.id,
    kind: 'review',
    dueDate: '2026-10-24',
  });
  return { project, line, milestone, entries: [project, line, milestone].map(entry) };
};
it('四个独立实体只存直接归属，待办没有自己的日期，重要性范围为 1–5', () => {
  const { milestone, entries } = setup();
  const todo = make('todo', { title: '核对指标', milestoneId: milestone.id });
  validateChange(todo, entries);
  expect(todo).not.toHaveProperty('dueDate');
  expect(() => make('todo', { ...todo, dueDate: '2026-10-24' })).toThrow();
  expect(() => make('todo', { ...todo, importance: 6 })).toThrow();
  expect(() =>
    validateChange(make('todo', { ...todo, milestoneId: entries[0].data.id }), entries),
  ).toThrow('跨层级');
  expect(todoContexts([...entries, entry(todo)])[0].project.title).toBe('项目 A');
});
it('今日只显示节点日期覆盖当天的待办，逾期 From 在联络清单中跟进', () => {
  const { line, milestone, entries } = setup();
  const tomorrow = make('milestone', { title: '明天', lineId: line.id, dueDate: '2026-10-25' });
  const overdue = make('milestone', { title: '昨天', lineId: line.id, dueDate: '2026-10-23' });
  const todayTodo = make('todo', { title: '今天的事', milestoneId: milestone.id });
  const futureTodo = make('todo', { title: '明天的事', milestoneId: tomorrow.id });
  const wait = make('todo', {
    title: '该收到的图',
    milestoneId: overdue.id,
    direction: 'from',
    person: '小王',
  });
  const all = [...entries, ...[tomorrow, overdue, todayTodo, futureTodo, wait].map(entry)];
  expect(todosForDay(all, '2026-10-24').map((c) => c.todo.title)).toEqual(['今天的事']);
  expect(contactsForDay(all, '2026-10-24')[0].todos[0].todo.title).toBe('该收到的图');
});
it('To / From 必须有联系人，等待项在当天清单和联络清单中可查看', () => {
  const { milestone, entries } = setup();
  const from = make('todo', {
    title: '实验图',
    milestoneId: milestone.id,
    direction: 'from',
    person: '小王',
    status: 'Waiting',
    importance: 5,
  });
  const to = make('todo', {
    title: '交出修改要求',
    milestoneId: milestone.id,
    direction: 'to',
    person: '小王',
  });
  expect(() => validateChange(make('todo', { ...from, person: '' }), entries)).toThrow('联系人');
  const all = [...entries, entry(from), entry(to)];
  expect(todosForDay(all, '2026-10-24').map((c) => c.todo.id)).toContain(from.id);
  expect(contactGroups(all, '2026-10-24')[0]).toMatchObject({
    person: '小王',
    todos: expect.any(Array),
  });
  expect(contactGroups(all)[0].todos).toHaveLength(2);
});
it('当天待办首先按自身重要性排序，同档先到期再看工作量，不受上级重要性盖过', () => {
  const { line, milestone, entries } = setup();
  const urgentPoint = make('milestone', {
    title: '同日较低权重',
    lineId: line.id,

    dueDate: '2026-10-24',
    importance: 1,
  });
  const slow = make('todo', {
    title: '长任务',
    milestoneId: milestone.id,
    importance: 3,
    estimatedMinutes: 120,
  });
  const quick = make('todo', {
    title: '短任务',
    milestoneId: milestone.id,
    importance: 3,
    estimatedMinutes: 15,
  });
  const important = make('todo', { title: '更重要', milestoneId: urgentPoint.id, importance: 5 });
  const all = [...entries, ...[urgentPoint, slow, quick, important].map(entry)];
  expect(todosForDay(all, '2026-10-24').map((c) => c.todo.title)).toEqual([
    '更重要',
    '短任务',
    '长任务',
  ]);
  expect(dueLabel('2026-10-26', '2026-10-24')).toBe('后天');
});
it('计划只从当天工作空间节点推导，无待办和已完成节点仍可回看，不生成小时安排或记录副本', () => {
  const { line, milestone, entries } = setup();
  const done = make('milestone', {
    title: '已完成讨论',
    lineId: line.id,

    dueDate: '2026-10-24',
    status: 'Done',
  });
  const future = make('milestone', { title: '明天节点', lineId: line.id, dueDate: '2026-10-25' });
  const none = make('milestone', { title: '无日期节点', lineId: line.id });
  const all = [...entries, ...[done, future, none].map(entry)];
  expect(
    milestonesForDay(all, '2026-10-24')
      .map((c) => c.milestone.id)
      .sort(),
  ).toEqual([done.id, milestone.id].sort());
  expect(milestonesForDay(all, '2026-10-24')[0]).not.toHaveProperty('startTime');
  expect(all).toHaveLength(6);
});
it('实际记录联动完成待办，移除勾选可恢复，不重复写一份任务状态，时间按项目归属', () => {
  const { milestone, entries } = setup();
  const todo = make('todo', { title: '核对指标', milestoneId: milestone.id });
  const actual = make('actual', {
    date: '2026-10-24',
    startTime: '09:03',
    endTime: '09:37',
    description: '核对指标',
    completedTodoIds: [todo.id],
  });
  const all = [...entries, entry(todo), entry(actual)];
  validateChange(actual, all);
  if (todo.type !== 'todo') throw new Error();
  expect(todoStatus(todo, all)).toBe('Done');
  expect(todo.status).toBe('Ready');
  expect(todoStatus(todo, [...entries, entry(todo)])).toBe('Ready');
  expect(timeTotals(all, '2026-10-24', '2026-10-24').projects).toEqual({ '项目 A': 34 });
  expect(() =>
    validateChange(
      make('actual', { ...actual, id: randomUUID(), startTime: '10:00', endTime: '10:30' }),
      all,
    ),
  ).toThrow('已有实际完成记录');
  expect(() =>
    validateChange(make('actual', { ...actual, completedTodoIds: [todo.id, todo.id] }), all),
  ).toThrow('不能重复');
});

it('节点只有截止点，时刻需日期，拒绝开始字段和无效时刻，按截止时刻自动排序', () => {
  const { milestone } = setup();
  expect(() => make('milestone', { ...milestone, startDate: '2026-10-23' })).toThrow();
  expect(() => make('milestone', { ...milestone, startTime: '09:00' })).toThrow();
  expect(() => make('milestone', { ...milestone, endTime: '10:00' })).toThrow();
  expect(() => make('milestone', { ...milestone, dueDate: null, dueTime: '09:00' })).toThrow(
    '截止日期',
  );
  expect(() => make('milestone', { ...milestone, dueTime: '25:00' })).toThrow();
  const early = make('milestone', { ...milestone, dueTime: '09:00' }) as Milestone;
  const late = make('milestone', {
    ...milestone,
    id: randomUUID(),
    dueTime: '11:00',
    order: -100,
  }) as Milestone;
  const none = make('milestone', { ...milestone, id: randomUUID(), dueDate: null }) as Milestone;
  expect([none, late, early].sort(compareMilestones).map((p) => p.id)).toEqual([
    early.id,
    late.id,
    none.id,
  ]);
  expect(milestoneTimeOnDay(early, '2026-10-24')).toBe(540);
  expect(milestoneTimeOnDay(early, '2026-10-25')).toBeNull();
  const midnight = make('milestone', { ...milestone, dueTime: '00:00' }) as Milestone;
  expect(milestoneTimeOnDay(midnight, '2026-10-24')).toBe(0);
  expect(milestoneTimeOnDay(milestone as Milestone, '2026-10-24')).toBeNull();
});
it('实际区块可多次关联一个或多个待办，记录工作不强制完成，关联后正确计入项目', () => {
  const { milestone, entries } = setup();
  const a = make('todo', { title: '任务 A', milestoneId: milestone.id }),
    b = make('todo', { title: '任务 B', milestoneId: milestone.id });
  const first = make('actual', {
    date: '2026-10-24',
    startTime: '09:00',
    endTime: '10:00',
    description: '推进两项',
    workedTodoIds: [a.id, b.id],
  });
  const all = [...entries, ...[a, b, first].map(entry)];
  validateChange(first, all);
  expect(todoStatus(a as import('../packages/domain/index').Todo, all)).toBe('Ready');
  expect(timeTotals(all, '2026-10-24', '2026-10-24').projects).toEqual({ '项目 A': 60 });
  const second = make('actual', {
    date: '2026-10-24',
    startTime: '10:00',
    endTime: '10:30',
    description: '完成 A，继续 B',
    workedTodoIds: [b.id],
    completedTodoIds: [a.id],
  });
  validateChange(second, all);
  expect(todoStatus(a as import('../packages/domain/index').Todo, [...all, entry(second)])).toBe(
    'Done',
  );
  expect(() => validateChange(make('actual', { ...second, workedTodoIds: [a.id] }), all)).toThrow(
    '重复',
  );
  expect(() =>
    validateChange(make('actual', { ...second, workedTodoIds: [randomUUID()] }), all),
  ).toThrow('不存在');
});
