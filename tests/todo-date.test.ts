import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseRecord, type Entry } from '../packages/domain/index';
import { contactsForDay, milestonesForDay, recentTodos, todosForDay } from '../packages/domain/workspace';

const make = (type: string, fields: object): Entry => ({
  data: parseRecord({ schemaVersion: 1, type, id: randomUUID(), createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z', ...fields }),
  path: '', revision: '',
});

it('待办独立日期优先，留空沿用节点；今日、联络和排序使用同一日期，节点计划不变', () => {
  const project = make('project', { title: '项目' });
  const line = make('workline', { title: '线', projectId: project.data.id });
  const milestone = make('milestone', { title: '后天交付', lineId: line.data.id, dueDate: '2026-10-26' });
  const todo = (title: string, dueDate: string | null) => make('todo', {
    title, milestoneId: milestone.data.id, dueDate, direction: 'from', person: '小王',
  });
  const early = todo('提前完成', '2026-10-24');
  const inherited = todo('沿用节点', null);
  const future = todo('明天完成', '2026-10-25');
  const overdue = todo('昨天完成', '2026-10-23');
  const all = [project, line, milestone, inherited, future, early, overdue];
  expect(todosForDay(all, '2026-10-24').map((c) => c.todo.id)).toEqual([early.data.id]);
  expect(todosForDay(all, '2026-10-26').map((c) => c.todo.id)).toEqual([inherited.data.id]);
  expect(contactsForDay(all, '2026-10-24')[0].todos.map((c) => c.todo.id)).toEqual([overdue.data.id, early.data.id]);
  expect(recentTodos(all, '2026-10-24').map((c) => c.todo.id)).toEqual([overdue.data.id, early.data.id, future.data.id, inherited.data.id]);
  expect(milestonesForDay(all, '2026-10-24')).toEqual([]);
  expect(milestonesForDay(all, '2026-10-26')[0].milestone.dueDate).toBe('2026-10-26');
  const higher = { ...future, data: parseRecord({ ...future.data, importance: 5, dueDate: '2026-11-01' }) };
  expect(recentTodos([...all.filter((e) => e !== future), higher], '2026-10-24')[0].todo.id).toBe(future.data.id);
});

it('待办日期可不填，拒绝无效日期和时刻字段；无节点日期时仍可安排待办', () => {
  const todo = make('todo', { title: '待办', milestoneId: randomUUID() });
  expect(todo.data).toHaveProperty('dueDate', null);
  expect(() => parseRecord({ ...todo.data, dueDate: '2026-02-30' })).toThrow();
  expect(() => parseRecord({ ...todo.data, dueTime: '09:00' })).toThrow();
  const project = make('project', { title: '项目' });
  const line = make('workline', { title: '线', projectId: project.data.id });
  const milestone = make('milestone', { title: '日期未定', lineId: line.data.id });
  const dated = make('todo', { title: '先做', milestoneId: milestone.data.id, dueDate: '2026-10-24' });
  const undated = make('todo', { title: '未安排', milestoneId: milestone.data.id });
  expect(todosForDay([project, line, milestone, dated, undated], '2026-10-24').map((c) => c.todo.id)).toEqual([dated.data.id]);
});
