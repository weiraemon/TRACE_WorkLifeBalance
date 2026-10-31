import type { ActualRecord, Entry } from '../../../../../packages/domain/index';
export const actualsForDay = (entries: Entry[], date: string) =>
  entries
    .filter(
      (entry): entry is Entry & { data: ActualRecord } =>
        entry.data.type === 'actual' && entry.data.date === date,
    )
    .sort(
      (a, b) =>
        a.data.startTime.localeCompare(b.data.startTime) || a.data.id.localeCompare(b.data.id),
    );
