import type { Snapshot } from '../../../../../packages/domain/index';
import type { Editor } from '../../types/editor';
import { ActualRecordList } from '../actual/ActualRecordList';
import type { ReviewData } from './reviewData';
export function ReviewActuals({
  data,
  date,
  snapshot,
  edit,
  setDate,
}: {
  data: ReviewData;
  date: string;
  snapshot: Snapshot;
  edit: (editor: Editor) => void;
  setDate: (date: string) => void;
}) {
  const { dayActuals, recordedDays } = data;
  return (
    <section className="review-actuals" aria-label="回顾实际记录">
      <h2>当天做过 · {date}</h2>
      <ActualRecordList entries={dayActuals} snapshot={snapshot} edit={edit} />
      {!dayActuals.length && <p className="hint">这一天没有实际记录。</p>}
      {recordedDays.some((day) => day.date !== date) && (
        <div className="recorded-days">
          <span>本周有记录的日期</span>
          {recordedDays
            .filter((day) => day.date !== date)
            .map((day) => (
              <button key={day.date} onClick={() => setDate(day.date)}>
                {day.date} · {(day.minutes / 60).toFixed(1)} h
              </button>
            ))}
        </div>
      )}
    </section>
  );
}
