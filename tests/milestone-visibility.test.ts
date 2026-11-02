import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseRecord, type Milestone, type Entry, type Todo } from '../packages/domain/index';
import { shouldHideCompleted } from '../packages/domain/workspace';

const entry = (data: Entry['data']): Entry => ({ data, path: '', revision: '' });
const node = (fields: object = {}) =>
  parseRecord({
    schemaVersion: 1,
    type: 'milestone',
    title: '节点',
    id: randomUUID(),
    lineId: randomUUID(),
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    completedAt: '2026-10-28T12:00:00Z',
    ...fields,
  }) as Milestone;

it('截止日期为两天前及更早且已完成时隐藏，昨天、未来、无日期及待办池保持显示', () => {
  for (const [dueDate, hidden] of [
    ['2026-10-27', true],
    ['2026-10-28', true],
    ['2026-10-29', false],
    ['2026-10-30', false],
    ['2026-10-31', false],
    [null, false],
  ] as const)
    expect(shouldHideCompleted(node({ dueDate }), [], '2026-10-30')).toBe(hidden);
  expect(shouldHideCompleted(node({ pool: true, completedAt: null }), [], '2026-10-30')).toBe(
    false,
  );
});

it('跨月、跨年和闰月保持本地日期的两天边界，不按截止时刻提前隐藏', () => {
  expect(
    shouldHideCompleted(node({ dueDate: '2026-12-31', dueTime: '00:00' }), [], '2027-01-01'),
  ).toBe(false);
  expect(
    shouldHideCompleted(node({ dueDate: '2026-12-30', dueTime: '00:00' }), [], '2027-01-01'),
  ).toBe(true);
  expect(
    shouldHideCompleted(node({ dueDate: '2026-12-29', dueTime: '23:59' }), [], '2027-01-01'),
  ).toBe(true);
  expect(shouldHideCompleted(node({ dueDate: '2024-02-28' }), [], '2024-03-01')).toBe(true);
  expect(shouldHideCompleted(node({ dueDate: '2024-02-29' }), [], '2024-03-01')).toBe(false);
  expect(shouldHideCompleted(node({ dueDate: '2024-02-27' }), [], '2024-03-01')).toBe(true);
});

it('11月3日隐藏11月1日及更早已完成条目，独立日期优先，留空继承节点，池本身保留', () => {
  const milestone = node({ dueDate: '2026-11-01' });
  const todo = parseRecord({
    schemaVersion: 1,
    type: 'todo',
    id: randomUUID(),
    title: '准备',
    milestoneId: milestone.id,
    createdAt: milestone.createdAt,
    updatedAt: milestone.updatedAt,
    completedAt: '2026-11-03T01:00:00Z',
  }) as Todo;
  expect(shouldHideCompleted(milestone, [], '2026-11-03')).toBe(true);
  for (const [dueDate, hidden] of [
    ['2026-10-31', true],
    ['2026-11-01', true],
    ['2026-11-02', false],
    ['2026-11-03', false],
    ['2026-11-04', false],
    [null, true],
  ] as const) {
    expect(shouldHideCompleted({ ...todo, dueDate }, [entry(milestone)], '2026-11-03')).toBe(
      hidden,
    );
    expect(
      shouldHideCompleted(
        { ...todo, dueDate, completedAt: null },
        [entry(milestone)],
        '2026-11-03',
      ),
    ).toBe(false);
  }
  const undated = { ...milestone, dueDate: null, completedAt: null };
  expect(shouldHideCompleted(todo, [entry(undated)], '2026-11-03')).toBe(false);
  const pool = { ...undated, pool: true };
  expect(shouldHideCompleted({ ...todo, dueDate: '2026-11-01' }, [entry(pool)], '2026-11-03')).toBe(
    true,
  );
  expect(
    shouldHideCompleted(
      { ...todo, kind: 'idea', dueDate: '2026-11-01' },
      [entry(pool)],
      '2026-11-03',
    ),
  ).toBe(true);
  expect(shouldHideCompleted(todo, [], '2026-11-03')).toBe(false);
});

it('未完成节点永不因过期隐藏，有条目时按所有 TODO / IDEA 推导完成', () => {
  const milestone = node({ dueDate: '2026-01-01', completedAt: null });
  expect(shouldHideCompleted(milestone, [], '2026-10-30')).toBe(false);
  const child = parseRecord({
    schemaVersion: 1,
    type: 'todo',
    id: randomUUID(),
    title: '行动',
    milestoneId: milestone.id,
    createdAt: milestone.createdAt,
    updatedAt: milestone.updatedAt,
  });
  if (child.type !== 'todo') throw new Error();
  expect(
    shouldHideCompleted(
      milestone,
      [entry({ ...child, completedAt: '2026-10-01T00:00:00Z' })],
      '2026-10-30',
    ),
  ).toBe(true);
  const idea = { ...child, id: randomUUID(), kind: 'idea' as const };
  const completedNode = { ...milestone, completedAt: '2026-10-01T00:00:00Z' };
  expect(
    shouldHideCompleted(
      completedNode,
      [entry({ ...child, completedAt: '2026-10-01T00:00:00Z' }), entry(idea)],
      '2026-10-30',
    ),
  ).toBe(false);
});
