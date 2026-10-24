import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseRecord, type Milestone } from '../packages/domain/index';
import { compareMilestones } from '../packages/domain/workspace';

const point = (fields: object = {}) => parseRecord({
  schemaVersion: 1, type: 'milestone', title: '节点', id: randomUUID(), lineId: randomUUID(),
  createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z', ...fields,
}) as Milestone;

it('已定节点按日期时刻从左往右，未定靠右且最早创建的在最右，不受手填顺序影响', () => {
  const early = point({ dueDate: '2026-10-24', dueTime: '09:00', order: 100 });
  const late = point({ dueDate: '2026-10-24', dueTime: '18:00', order: -100 });
  const noTime = point({ dueDate: '2026-10-24' });
  const tomorrow = point({ dueDate: '2026-10-25', dueTime: '00:00' });
  const oldest = point({ createdAt: '2026-10-22T00:00:00Z', order: -100 });
  const middle = point({ createdAt: '2026-10-23T00:00:00Z' });
  const newest = point({ order: 100 });
  expect([oldest, late, middle, tomorrow, early, newest, noTime].sort(compareMilestones)).toEqual([
    early, late, noTime, tomorrow, newest, middle, oldest,
  ]);
  expect([oldest, point({ dueDate: '9999-12-31', dueTime: '23:59' })].sort(compareMilestones)[1]).toBe(oldest);
  expect([oldest, { ...middle, dueDate: '2026-10-23' }, early].sort(compareMilestones).map((p) => p.id)).toEqual([middle.id, early.id, oldest.id]);
});

it('相同创建时间以稳定 ID 打破平局，不因文件扫描顺序改变', () => {
  const a = point({ id: '00000000-0000-4000-8000-000000000001' });
  const b = point({ id: '00000000-0000-4000-8000-000000000002' });
  expect([a, b].sort(compareMilestones)).toEqual([b, a]);
  expect([b, a].sort(compareMilestones)).toEqual([b, a]);
});
