import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  parseRecord,
  validateChange,
  weekStart,
  timeTotals,
  type Entry,
  type RecordData,
} from '../packages/domain/index';
const base = () => ({
  schemaVersion: 1,
  id: randomUUID(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
const make = (type: string, fields: object = {}) => parseRecord({ ...base(), type, ...fields });
const entry = (data: RecordData): Entry => ({ data, path: '', revision: '' });
describe('当前契约与时间', () => {
  it('只有七种当前类型，旧类型与多余字段不再接受', () => {
    for (const type of [
      'node',
      'timeblock',
      'event',
      'iteration',
      'commitment',
      'dependency',
      'gate',
    ])
      expect(() => make(type, { title: '旧记录' })).toThrow();
    expect(() => make('project', { title: '项目', parentId: randomUUID() })).toThrow();
    expect(() =>
      make('actual', {
        date: '2026-10-24',
        startTime: '09:00',
        endTime: '10:00',
        description: '工作',
        mode: 'actual',
      }),
    ).toThrow();
  });
  it('节点可不设日期，拒绝无效截止日期、开始字段与零长度实际，支持午夜', () => {
    const m = make('milestone', { title: '讨论', lineId: randomUUID() });
    expect(m).toMatchObject({ dueTime: null, dueDate: null, status: 'Ready' });
    expect(() => make('milestone', { ...m, dueDate: '2026-02-30' })).toThrow();
    expect(() =>
      make('milestone', { ...m, startDate: '2026-10-25', dueDate: '2026-10-24' }),
    ).toThrow();
    expect(() =>
      make('actual', {
        date: '2026-10-24',
        startTime: '09:00',
        endTime: '09:00',
        description: '工作',
      }),
    ).toThrow('晚于');
    expect(weekStart('2026-10-25')).toBe('2026-10-19');
  });
  it('实际不重复计时，跨项目不编造分摊，未关联时间可独立记录', () => {
    const project = make('project', { title: '科研' }),
      line = make('workline', { title: '报告', projectId: project.id }),
      point = make('milestone', { title: '审阅', lineId: line.id }),
      todo = make('todo', { title: '核对', milestoneId: point.id });
    const actual = make('actual', {
      date: '2026-10-23',
      startTime: '23:00',
      endTime: '24:00',
      description: '核对报告',
      completedTodoIds: [todo.id],
    });
    const entries = [project, line, point, todo, actual].map(entry);
    expect(() =>
      validateChange(
        make('actual', { ...actual, id: randomUUID(), completedTodoIds: [], startTime: '23:30' }),
        entries,
      ),
    ).toThrow('重叠');
    expect(timeTotals(entries, '2026-10-19', '2026-10-25')).toEqual({
      total: 60,
      projects: { 科研: 60 },
    });
    const external = make('actual', { ...actual, id: randomUUID(), startTime: '23:30' });
    expect(
      timeTotals([...entries, entry(external), entry(actual)], '2026-10-19', '2026-10-25').total,
    ).toBe(60);
    expect(
      timeTotals(
        [entry(make('actual', { ...actual, completedTodoIds: [] }))],
        '2026-10-19',
        '2026-10-25',
      ).projects,
    ).toEqual({ 未关联: 60 });
    const p2 = make('project', { title: '项目 B' }),
      l2 = make('workline', { title: '论文', projectId: p2.id }),
      m2 = make('milestone', { title: '讨论', lineId: l2.id }),
      t2 = make('todo', { title: '写作', milestoneId: m2.id });
    expect(
      timeTotals(
        [
          ...entries.filter((e) => e.data.type !== 'actual'),
          ...[
            p2,
            l2,
            m2,
            t2,
            make('actual', { ...actual, completedTodoIds: [todo.id, t2.id] }),
          ].map(entry),
        ],
        '2026-10-19',
        '2026-10-25',
      ).projects,
    ).toEqual({ '跨项目（未分摊）': 60 });
  });
});
