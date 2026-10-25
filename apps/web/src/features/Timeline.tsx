import { useEffect, useRef } from 'react';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { CalendarOptions, EventChangeArg } from '@fullcalendar/core';
import { clock, localDay, type Snapshot } from '../../../../packages/domain/index';
import { milestonesForDay, milestoneTimeOnDay } from '../../../../packages/domain/workspace';
import { ImportanceDot } from '../components/Importance';
import { save, createRecord } from '../api';
import type { Editor } from './editor';
import { PlanNode } from './PlanNode';
const calendarOptions: CalendarOptions = {
  plugins: [timeGridPlugin, interactionPlugin],
  initialView: 'timeGridDay',
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
export function Timeline({
  date,
  snapshot,
  edit,
  reload,
  run,
  goWorkspace,
}: {
  date: string;
  snapshot: Snapshot;
  edit: (editor: Editor) => void;
  reload: () => Promise<void>;
  run: (fn: () => Promise<unknown>) => void;
  goWorkspace: (id: string) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 8 * 72;
  }, []);
  const blocks = snapshot.entries.filter((e) => e.data.type === 'actual' && e.data.date === date);
  const plans = milestonesForDay(snapshot.entries, date);
  const timed = plans.flatMap((context) => {
    const minute = milestoneTimeOnDay(context.milestone, date);
    return minute === null ? [] : [{ context, minute }];
  });
  const untimed = plans.filter((c) => milestoneTimeOnDay(c.milestone, date) === null);
  const change = (arg: EventChangeArg) => {
    const entry = blocks.find((e) => e.data.id === arg.event.id);
    if (entry?.data.type !== 'actual') return;
    run(async () => {
      try {
        const start = arg.event.start!,
          end = arg.event.end!;
        await save(
          createRecord('actual', {
            ...entry.data,
            startTime: clock(start.getHours() * 60 + start.getMinutes()),
            endTime:
              localDay(end) !== localDay(start)
                ? '24:00'
                : clock(end.getHours() * 60 + end.getMinutes()),
          }),
          entry,
        );
        await reload();
      } catch (error) {
        arg.revert();
        throw error;
      }
    });
  };
  return (
    <section className="timeline-section daily-timeline" aria-label="今日状况">
      <div className="section-heading">
        <h2>今日状况</h2>
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
              <button
                className="plan-node"
                key={milestone.id}
                data-space-id={milestone.id}
                onClick={() => goWorkspace(milestone.id)}
              >
                <ImportanceDot value={milestone.importance} />
                {milestone.title}
                <small>{project.title}</small>
              </button>
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
                  <PlanNode
                    key={plan.context.milestone.id}
                    context={plan.context}
                    snapshot={snapshot}
                    timeLabel={timeLabel}
                    goWorkspace={goWorkspace}
                  />
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
              selectable
              editable
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
                const titles = record.itemIds
                  .map((id) => snapshot.entries.find((e) => e.data.id === id)?.data)
                  .map((r) => (r && 'title' in r ? r.title : '待办已移除'));
                return (
                  <div
                    className="actual-content"
                    title={`${record.description}${titles.length ? '\n关联待办：' + titles.join(' / ') : ''}`}
                  >
                    <div className="fc-event-time">{arg.timeText}</div>
                    <div className="fc-event-title">{record.description}</div>
                    {titles.map((title, index) => (
                      <div
                        className="actual-todo-line"
                        data-space-id={record.itemIds[index]}
                        key={`${index}-${title}`}
                      >
                        {index === 0 ? '关联：' : ''}
                        {title}
                      </div>
                    ))}
                  </div>
                );
              }}
              select={(arg) =>
                edit({
                  type: 'actual',
                  defaults: {
                    date,
                    startTime: clock(arg.start.getHours() * 60 + arg.start.getMinutes()),
                    endTime:
                      localDay(arg.end) !== localDay(arg.start)
                        ? '24:00'
                        : clock(arg.end.getHours() * 60 + arg.end.getMinutes()),
                  },
                })
              }
              eventChange={change}
              eventClick={(arg) => {
                const entry = blocks.find((e) => e.data.id === arg.event.id);
                if (entry) edit({ type: 'actual', entry });
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
