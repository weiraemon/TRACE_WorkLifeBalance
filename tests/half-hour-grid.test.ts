import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseRecord, type Entry } from '../packages/domain/index';
import { halfHourAvailability } from '../apps/web/src/features/actual/HalfHourGrid';

const actual = (startTime: string, endTime: string): Entry => ({
  data: parseRecord({
    type: 'actual',
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    date: '2026-11-16',
    startTime,
    endTime,
    description: '合成时间段',
  }),
  path: 'test.md',
  revision: 'test',
});

it('精确到分钟的旧记录占用所有相交格子，其他格子可选', () => {
  const available = halfHourAvailability([actual('10:15', '10:45')], '2026-11-16');
  expect(available).toHaveLength(48);
  expect(available.slice(19, 23)).toEqual([true, false, false, true]);
});
it('当日 24:00 为最后一个格子的结束，其他日期独立', () => {
  const entries = [actual('23:30', '24:00')];
  expect(halfHourAvailability(entries, '2026-11-16')[47]).toBe(false);
  expect(halfHourAvailability(entries, '2026-11-17').every(Boolean)).toBe(true);
});
it('编辑实际记录时释放自身时间，继续保护其他记录', () => {
  const current = actual('08:00', '09:00');
  const available = halfHourAvailability(
    [current, actual('09:00', '09:30')],
    '2026-11-16',
    current.data.id,
  );
  expect(available.slice(16, 19)).toEqual([true, true, false]);
});
