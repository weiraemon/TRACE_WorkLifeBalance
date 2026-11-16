import { useRef, useState } from 'react';
import { clock, minutes, type Entry } from '../../../../../packages/domain/index';

export function halfHourAvailability(entries: Entry[], date: string, excludeId?: string) {
  const records = entries.flatMap(({ data }) =>
    data.type === 'actual' && data.date === date && data.id !== excludeId ? [data] : [],
  );
  return Array.from(
    { length: 48 },
    (_, index) =>
      !records.some(
        (record) =>
          index * 30 < minutes(record.endTime) && (index + 1) * 30 > minutes(record.startTime),
      ),
  );
}

export function HalfHourGrid({
  available,
  startTime,
  endTime,
  onChange,
}: {
  available: boolean[];
  startTime: string;
  endTime: string;
  onChange: (start: string, end: string) => void;
}) {
  const anchor = useRef(Math.floor(minutes(startTime) / 30));
  const dragging = useRef(false);
  const [focused, setFocused] = useState(() => Math.floor(minutes(startTime) / 30));
  const focusIndex = available[focused] ? focused : available.indexOf(true);
  const select = (index: number) => {
    const start = Math.min(anchor.current, index);
    const end = Math.max(anchor.current, index) + 1;
    if (available.slice(start, end).every(Boolean)) onChange(clock(start * 30), clock(end * 30));
  };
  return (
    <section className="half-hour-picker" aria-label="选择实际工作时间">
      <div className="half-hour-caption">
        <span>点选或拖选 · 每格 30 分钟</span>
        <small>灰格已记录</small>
      </div>
      <div
        className="half-hour-grid"
        role="group"
        aria-label="一天的 48 个半小时"
        onPointerMove={(event) => {
          if (!dragging.current) return;
          const cell = document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest<HTMLElement>('[data-half-hour]');
          if (cell && event.currentTarget.contains(cell)) select(Number(cell.dataset.halfHour));
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onLostPointerCapture={() => {
          dragging.current = false;
        }}
      >
        {available.map((free, index) => (
          <button
            key={index}
            type="button"
            data-half-hour={index}
            disabled={!free}
            tabIndex={index === focusIndex ? 0 : -1}
            onFocus={() => setFocused(index)}
            onKeyDown={(event) => {
              const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 }[event.key];
              if (!offset) return;
              event.preventDefault();
              let next = index + offset;
              while (next >= 0 && next < available.length && !available[next]) next += offset;
              if (next < 0 || next >= available.length) return;
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>(`[data-half-hour="${next}"]`)
                ?.focus();
              if (event.shiftKey) select(next);
            }}
            aria-label={`${clock(index * 30)}–${clock((index + 1) * 30)}${free ? '' : '，已记录'}`}
            aria-pressed={index * 30 < minutes(endTime) && (index + 1) * 30 > minutes(startTime)}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              if (!event.shiftKey) anchor.current = index;
              dragging.current = true;
              event.currentTarget.parentElement?.setPointerCapture(event.pointerId);
              select(index);
            }}
            onClick={(event) => {
              if (event.detail !== 0) return;
              if (!event.shiftKey) anchor.current = index;
              select(index);
            }}
          >
            {clock(index * 30)}
          </button>
        ))}
      </div>
    </section>
  );
}
