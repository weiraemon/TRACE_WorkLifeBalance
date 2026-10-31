import { useId, useRef, type ReactNode, type Ref } from 'react';
export function SlidingTabs({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: { label: string; content: ReactNode; panelRef?: Ref<HTMLDivElement> }[];
  value: number;
  onChange: (index: number) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  return (
    <div className="sliding-tabs" ref={root}>
      <div
        className="sliding-tabs-list"
        role="tablist"
        aria-label={label}
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      >
        {items.map((item, index) => (
          <button
            key={item.label}
            id={`${id}-tab-${index}`}
            type="button"
            role="tab"
            aria-selected={value === index}
            aria-controls={`${id}-panel-${index}`}
            tabIndex={value === index ? 0 : -1}
            onClick={() => onChange(index)}
            onKeyDown={(event) => {
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : event.key === 'ArrowLeft'
                      ? (index + items.length - 1) % items.length
                      : event.key === 'ArrowRight'
                        ? (index + 1) % items.length
                        : null;
              if (next === null) return;
              event.preventDefault();
              onChange(next);
              root.current
                ?.querySelector<HTMLButtonElement>(`[id="${id}-tab-${next}"]`)
                ?.focus({ preventScroll: true });
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="sliding-tabs-viewport">
        {items.map((item, index) => (
          <div
            key={item.label}
            ref={item.panelRef}
            id={`${id}-panel-${index}`}
            role="tabpanel"
            aria-labelledby={`${id}-tab-${index}`}
            aria-hidden={value !== index}
            inert={value !== index}
            className="sliding-tabs-panel"
            style={{ transform: `translateX(${(index - value) * 100}%)` }}
          >
            {item.content}
          </div>
        ))}
      </div>
    </div>
  );
}
