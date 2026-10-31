import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseRecord, type Milestone, type Entry } from '../packages/domain/index';
import { shouldHideMilestone } from '../packages/domain/workspace';

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

it('截止日期超过两天才隐藏，恰好两天、未来、无日期及待办池保持显示', () => {
  for (const [dueDate, hidden] of [
    ['2026-10-27', true],
    ['2026-10-28', false],
    ['2026-10-29', false],
    ['2026-10-30', false],
    ['2026-10-31', false],
    [null, false],
  ] as const)
    expect(shouldHideMilestone(node({ dueDate }), [], '2026-10-30')).toBe(hidden);
  expect(shouldHideMilestone(node({ pool: true, completedAt: null }), [], '2026-10-30')).toBe(
    false,
  );
  expect(
    shouldHideMilestone(
      node({ dueDate: '2026-10-27', completedAt: '2026-10-28T12:00:00Z' }),
      [],
      '2026-10-30',
    ),
  ).toBe(true);
});

it('跨月、跨年和闰月保持本地日期的两天边界，不按截止时刻提前隐藏', () => {
  expect(
    shouldHideMilestone(node({ dueDate: '2026-12-30', dueTime: '00:00' }), [], '2027-01-01'),
  ).toBe(false);
  expect(
    shouldHideMilestone(node({ dueDate: '2026-12-29', dueTime: '23:59' }), [], '2027-01-01'),
  ).toBe(true);
  expect(shouldHideMilestone(node({ dueDate: '2024-02-28' }), [], '2024-03-01')).toBe(false);
  expect(shouldHideMilestone(node({ dueDate: '2024-02-27' }), [], '2024-03-01')).toBe(true);
});

it('未完成节点永不因过期隐藏，有条目时按所有 TODO / IDEA 推导完成', () => {
  const milestone = node({ dueDate: '2026-01-01', completedAt: null });
  expect(shouldHideMilestone(milestone, [], '2026-10-30')).toBe(false);
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
  const entry = (data: Entry['data']): Entry => ({ data, path: '', revision: '' });
  expect(
    shouldHideMilestone(
      milestone,
      [entry({ ...child, completedAt: '2026-10-01T00:00:00Z' })],
      '2026-10-30',
    ),
  ).toBe(true);
  const idea = { ...child, id: randomUUID(), kind: 'idea' as const };
  const completedNode = { ...milestone, completedAt: '2026-10-01T00:00:00Z' };
  expect(
    shouldHideMilestone(
      completedNode,
      [entry({ ...child, completedAt: '2026-10-01T00:00:00Z' }), entry(idea)],
      '2026-10-30',
    ),
  ).toBe(false);
});
