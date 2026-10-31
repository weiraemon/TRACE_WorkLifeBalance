import { useEffect, useRef } from 'react';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import type { CalendarOptions } from '@fullcalendar/core';
import { clock, localDay, minutes, type Snapshot } from '../../../../../packages/domain/index';
import { milestonesForDay, milestoneTimeOnDay } from '../../../../../packages/domain/workspace';
import { ImportanceDot } from '../../components/Importance';
const calendarOptions: CalendarOptions = {
  plugins: [timeGridPlugin],
  initialView: 'timeGridDay',
  windowResizeDelay: 0,
  headerToolbar: false,
  dayHeaders: false,
  allDaySlot: false,
  height: 'auto',
  slotMinTime: '00:00:00',
  slotMaxTime: '24:00:00',
  slotDuration: '00:15:00',
  snapDuration: '00:15:00',
  eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
};
export function Timeline({ date, snapshot }: { date: string; snapshot: Snapshot }) {
  const scroll = useRef<HTMLDivElement>(null);
  const blocks = snapshot.entries.filter((e) => e.data.type === 'actual' && e.data.date === date);
  const plans = milestonesForDay(snapshot.entries, date);
  const timed = plans.flatMap((context) => {
    const minute = milestoneTimeOnDay(context.milestone, date);
    return minute === null ? [] : [{ context, minute }];
  });
  const untimed = plans.filter((c) => milestoneTimeOnDay(c.milestone, date) === null);
  const firstMinute = Math.min(
    ...timed.map((plan) => plan.minute),
    ...blocks.flatMap((e) => (e.data.type === 'actual' ? [minutes(e.data.startTime)] : [])),
  );
  useEffect(() => {
    if (scroll.current)
      scroll.current.scrollTop =
        (Math.max(0, Number.isFinite(firstMinute) ? firstMinute - 60 : 480) / 60) * 72;
  }, [date, firstMinute]);
  return (
    <section className="timeline-section daily-timeline" aria-label="计划与实际">
      <div className="section-heading">
        <h2>计划与实际 · {date}</h2>
      </div>
      <div className="timeline-head">
        <div>
          <h3>计划</h3>
        </div>
        <div className="actual-heading">
          <h3>实际</h3>
        </div>
      </div>
      {untimed.length > 0 && (
        <details className="unscheduled-plans">
          <summary>未定时间 · {untimed.length} 个节点</summary>
          <div>
            {untimed.map(({ milestone, project }) => (
              <div className="plan-node" key={milestone.id}>
                <ImportanceDot value={milestone.importance} />
                {milestone.title}
                <small>{project.title}</small>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="timeline-scroll" ref={scroll} aria-label="每日计划与实际时间线">
        <div className="timeline-grid">
          <div className="calendar-side planned plan-side" aria-label="当天计划（只读）">
            <FullCalendar
              {...calendarOptions}
              key={date}
              initialDate={date}
              nowIndicator={date === localDay()}
              editable={false}
              selectable={false}
              slotEventOverlap={false}
              eventMinHeight={32}
              defaultTimedEventDuration="00:15:00"
              events={timed.map(({ context, minute }) => ({
                id: context.milestone.id,
                title: context.milestone.title,
                start: `${date}T${clock(minute)}:00`,
                classNames: ['planned-node'],
              }))}
              eventContent={(arg) => {
                const plan = timed.find((c) => c.context.milestone.id === arg.event.id);
                if (!plan) return null;
                const timeLabel = clock(plan.minute);
                return (
                  <div
                    className="plan-marker"
                    title={`${plan.context.line.title} · ${timeLabel} · ${plan.context.milestone.title}`}
                  >
                    <ImportanceDot value={plan.context.milestone.importance} />
                    <span>
                      {plan.context.milestone.title}
                      <small>
                        {plan.context.line.title} · {timeLabel}
                      </small>
                    </span>
                  </div>
                );
              }}
            />
          </div>
          <div className="calendar-side actual">
            <FullCalendar
              key={date}
              {...calendarOptions}
              initialDate={date}
              nowIndicator={date === localDay()}
              selectable={false}
              editable={false}
              events={blocks.map((e) => {
                if (e.data.type !== 'actual') throw new Error();
                return {
                  id: e.data.id,
                  title: e.data.description,
                  start: `${date}T${e.data.startTime}:00`,
                  end: `${date}T${e.data.endTime}:00`,
                  classNames: ['actual'],
                };
              })}
              eventContent={(arg) => {
                const record = blocks.find((e) => e.data.id === arg.event.id)?.data;
                if (record?.type !== 'actual') return null;
                const linkedIds = [...record.milestoneIds, ...record.itemIds];
                const titles = linkedIds
                  .map((id) => snapshot.entries.find((e) => e.data.id === id)?.data)
                  .map((r) => (r && 'title' in r ? r.title : '关联内容已移除'));
                return (
                  <div
                    className="actual-content"
                    title={`${record.description}${titles.length ? '\n关联：' + titles.join(' / ') : ''}`}
                  >
                    <div className="fc-event-time">{arg.timeText}</div>
                    <div className="fc-event-title">{record.description}</div>
                    {titles.map((title, index) => (
                      <div className="actual-todo-line" key={`${index}-${title}`}>
                        {index === 0 ? '关联：' : ''}
                        {title}
                      </div>
                    ))}
                  </div>
                );
              }}
            />
          </div>
          <div className="shared-scale">
            {Array.from({ length: 25 }, (_, hour) => (
              <time key={hour} style={{ top: hour * 72 }}>
                {String(hour).padStart(2, '0')}:00
              </time>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
