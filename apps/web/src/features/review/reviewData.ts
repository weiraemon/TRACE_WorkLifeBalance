import {
  localDay,
  weekStart,
  timeTotals,
  type Snapshot,
} from '../../../../../packages/domain/index';
import { todoContexts } from '../../../../../packages/domain/workspace';
import { actualsForDay } from '../actual/selectors';
export function reviewData(snapshot: Snapshot, date: string) {
  const week = weekStart(date);
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(week + 'T12:00:00');
    day.setDate(day.getDate() + index);
    const value = localDay(day);
    return { date: value, minutes: timeTotals(snapshot.entries, value, value).total };
  });
  const last = days[6].date;
  const totals = timeTotals(snapshot.entries, week, last);
  const max = Math.max(60, ...days.map((day) => day.minutes));
  const actuals = snapshot.entries.filter(
    (e) => e.data.type === 'actual' && e.data.date >= week && e.data.date <= last,
  );
  const dayActuals = actualsForDay(snapshot.entries, date);
  const recordedDays = days.filter((day) => day.minutes > 0);
  const completed = todoContexts(snapshot.entries).filter(
    (c) =>
      c.todo.completedAt &&
      localDay(new Date(c.todo.completedAt)) >= week &&
      localDay(new Date(c.todo.completedAt)) <= last,
  );
  return { week, last, days, totals, max, actuals, dayActuals, recordedDays, completed };
}
export type ReviewData = ReturnType<typeof reviewData>;
