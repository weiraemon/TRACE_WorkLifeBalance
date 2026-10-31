import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseRecord, type Entry } from '../packages/domain/index';
import { agendaForDay } from '../packages/domain/workspace';
it('定时项按时刻再按重要性，无时刻节点和待办统一按重要性，已完成项置底且不改原重要性', () => {
  const entries: Entry[] = [];
  const add = (type: string, fields: object) => {
    const data = parseRecord({
      schemaVersion: 1,
      id: randomUUID(),
      type,
      createdAt: '2026-10-30T00:00:00Z',
      updatedAt: '2026-10-30T00:00:00Z',
      ...fields,
    });
    entries.push({ data, path: '', revision: '' });
    return data;
  };
  const project = add('project', { title: '项目' }),
    line = add('workline', { title: '业务线', projectId: project.id });
  const node = (
    title: string,
    importance: number,
    dueTime: string | null = null,
    completedAt: string | null = null,
  ) =>
    add('milestone', {
      title,
      lineId: line.id,
      dueDate: '2026-10-30',
      dueTime,
      importance,
      completedAt,
    });
  node('九点低', 1, '09:00');
  node('九点高', 5, '09:00');
  node('八点', 1, '08:00');
  node('无时刻中', 3);
  const pool = add('milestone', { title: '待办池', lineId: line.id, pool: true });
  add('todo', { title: '无时刻高', milestoneId: pool.id, dueDate: '2026-10-30', importance: 5 });
  add('todo', { title: '无时刻低', milestoneId: pool.id, dueDate: '2026-10-30', importance: 1 });
  const completed = node('已完成七点', 5, '07:00', '2026-10-30T01:00:00Z');
  const before = JSON.stringify(entries);
  expect(agendaForDay(entries, '2026-10-30').map((row) => row.item.title)).toEqual([
    '八点',
    '九点高',
    '九点低',
    '无时刻高',
    '无时刻中',
    '无时刻低',
    '已完成七点',
  ]);
  expect(JSON.stringify(entries)).toBe(before);
  const undone = entries.find((e) => 'title' in e.data && e.data.title === '无时刻高')!;
  if (undone.data.type !== 'todo') throw new Error();
  undone.data.completedAt = '2026-10-30T02:00:00Z';
  const agenda = agendaForDay(entries, '2026-10-30');
  expect(agenda.slice(-2).every((row) => row.done)).toBe(true);
  expect(agenda.find((row) => row.item.id === completed.id)?.item.importance).toBe(5);
});
