import { useRef, useState } from 'react';
import type { Snapshot, SpaceItem } from '../../../../../packages/domain/index';
import { isComplete, type MilestoneContext } from '../../../../../packages/domain/workspace';

export function TodayNodeRow({
  context,
  snapshot,
  toggle,
  record,
}: {
  context: MilestoneContext;
  snapshot: Snapshot;
  toggle: (item: SpaceItem) => void;
  record: () => void;
}) {
  const { milestone, line } = context;
  const preview = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const done = isComplete(milestone, snapshot.entries);
  const children = snapshot.entries
    .flatMap(({ data }) =>
      data.type === 'todo' && data.milestoneId === milestone.id ? [data] : [],
    )
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
  const show = () => {
    const panel = preview.current,
      button = anchor.current;
    if (!panel || !button) return;
    const rect = button.getBoundingClientRect();
    panel.showPopover();
    panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - panel.offsetWidth - 12))}px`;
    panel.style.top = `${Math.max(12, Math.min(rect.bottom, innerHeight - panel.offsetHeight - 12))}px`;
  };
  const hide = () => preview.current?.hidePopover();
  return (
    <li
      className={`today-item-row today-node${done ? ' today-row-done' : ''}`}
      data-space-id={milestone.id}
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') show();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse' && !e.currentTarget.contains(document.activeElement)) hide();
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) hide();
      }}
    >
      <button
        className={`todo-check priority-${milestone.importance}`}
        role="checkbox"
        aria-label={`完成节点 ${milestone.title}`}
        aria-checked={done}
        onClick={() => toggle(milestone)}
      >
        {done ? '✓' : ''}
      </button>
      <button
        ref={anchor}
        className="today-row"
        aria-expanded={open}
        aria-controls={`node-preview-${milestone.id}`}
        onFocus={show}
        onClick={show}
      >
        <span className="today-task" title={milestone.title}>
          <small>{line.title}</small>
          <span title={milestone.title}>{milestone.title}</span>
        </span>
        {milestone.dueTime && <time>{milestone.dueTime}</time>}
      </button>
      <button className="record-source" aria-label={`记一段 · ${milestone.title}`} onClick={record}>
        记一段
      </button>
      <div
        ref={preview}
        id={`node-preview-${milestone.id}`}
        popover="auto"
        className="today-node-preview"
        role="region"
        aria-label={`${milestone.title}的全部待办`}
        onToggle={(e) => setOpen(e.newState === 'open')}
      >
        <strong>{milestone.title}</strong>
        <small>
          {line.title} · 全部条目 {children.length}
        </small>
        {children.length ? (
          <ul>
            {children.map((item) => (
              <li key={item.id} className={item.completedAt ? 'item-done' : ''}>
                <span>
                  {item.completedAt ? '✓' : '○'} {item.kind.toUpperCase()} · {item.title}
                </span>
                <small>{item.dueDate ?? milestone.dueDate}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">暂无所属待办</p>
        )}
        <button onClick={hide}>关闭预览</button>
      </div>
    </li>
  );
}
