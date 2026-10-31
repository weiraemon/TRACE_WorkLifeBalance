import { lazy, Suspense } from 'react';
import type { Snapshot } from '../../../../packages/domain/index';
import type { Editor } from '../types/editor';
import { DatePicker, EmptyState } from '../components/ui';
import { reviewData } from '../features/review/reviewData';
import { ReviewOverview } from '../features/review/ReviewOverview';
import { ReviewActuals } from '../features/review/ReviewActuals';
import { ReviewNotes } from '../features/review/ReviewNotes';
const Timeline = lazy(() =>
  import('../features/review/Timeline').then((module) => ({ default: module.Timeline })),
);
export function Review({
  snapshot,
  date,
  setDate,
  edit,
}: {
  snapshot: Snapshot;
  date: string;
  setDate: (date: string) => void;
  edit: (editor: Editor) => void;
}) {
  const data = reviewData(snapshot, date);
  const { week, last } = data;
  return (
    <div className="review-page">
      <div className="section-heading">
        <div>
          <h1>回顾</h1>
          <p className="hint">
            {week} — {last}
          </p>
        </div>
        <DatePicker
          aria-label="回顾日期"
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
        />
      </div>
      <ReviewOverview data={data} date={date} setDate={setDate} />
      <ReviewActuals data={data} date={date} snapshot={snapshot} edit={edit} setDate={setDate} />
      <Suspense fallback={<EmptyState>正在加载时间线…</EmptyState>}>
        <Timeline date={date} snapshot={snapshot} />
      </Suspense>
      <ReviewNotes data={data} snapshot={snapshot} />
    </div>
  );
}
