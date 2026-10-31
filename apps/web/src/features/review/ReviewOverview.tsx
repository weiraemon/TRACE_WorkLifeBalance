import type { ReviewData } from './reviewData';
export function ReviewOverview({
  data,
  date,
  setDate,
}: {
  data: ReviewData;
  date: string;
  setDate: (date: string) => void;
}) {
  const { totals, completed, actuals, days, max } = data;
  return (
    <>
      <section className="review-metrics" aria-label="本周概况">
        <div>
          <strong>
            {(totals.total / 60).toFixed(1)}
            <small>h</small>
          </strong>
          <span>实际投入</span>
        </div>
        <div>
          <strong>{completed.length}</strong>
          <span>完成条目</span>
        </div>
        <div>
          <strong>{actuals.length}</strong>
          <span>工作片段</span>
        </div>
      </section>
      <div className="review-charts">
        <section aria-label="每天投入">
          <h2>这一周的节奏</h2>
          <div className="week-bars">
            {days.map((day, index) => (
              <button
                key={day.date}
                aria-label={`${day.date} 实际投入 ${day.minutes} 分钟`}
                aria-pressed={date === day.date}
                onClick={() => setDate(day.date)}
              >
                <span>{(day.minutes / 60).toFixed(1)} h</span>
                <i style={{ height: `${Math.max(2, (day.minutes / max) * 120)}px` }} />
                <small>{['一', '二', '三', '四', '五', '六', '日'][index]}</small>
              </button>
            ))}
          </div>
        </section>
        <section aria-label="项目投入">
          <h2>时间花在哪里</h2>
          {Object.entries(totals.projects)
            .sort((a, b) => b[1] - a[1])
            .map(([title, minutes]) => (
              <div className="allocation" key={title}>
                <div>
                  <span>{title}</span>
                  <small>{(minutes / 60).toFixed(1)} h</small>
                </div>
                <div className="allocation-track">
                  <i style={{ width: `${totals.total ? (minutes / totals.total) * 100 : 0}%` }} />
                </div>
              </div>
            ))}
          {!totals.total && <p className="hint">本周还没有实际工作记录。</p>}
        </section>
      </div>
    </>
  );
}
