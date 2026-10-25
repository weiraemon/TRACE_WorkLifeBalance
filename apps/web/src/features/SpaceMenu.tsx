import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  isSpaceItem,
  localDay,
  type Entry,
  type Snapshot,
} from '../../../../packages/domain/index';
import { createRecord, save, promote } from '../api';
import { isComplete } from '../../../../packages/domain/workspace';
import type { Editor } from './editor';
import { spaceLabel } from './WorkItemForm';

export function SpaceMenu({
  snapshot,
  edit,
  remove,
  run,
  reload,
}: {
  snapshot: Snapshot;
  edit: (editor: Editor) => void;
  remove: (entry: Entry) => void;
  run: (fn: () => Promise<unknown>) => void;
  reload: () => Promise<void>;
}) {
  const [menu, setMenu] = useState<{
    entry: Entry;
    x: number;
    y: number;
    trigger: HTMLElement;
    date: boolean;
  } | null>(null);
  useEffect(() => {
    const open = (event: MouseEvent | KeyboardEvent) => {
      if (
        event instanceof KeyboardEvent &&
        event.key !== 'ContextMenu' &&
        !(event.shiftKey && event.key === 'F10')
      )
        return;
      const trigger =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('.point-dates, .todo-date, [data-space-id]')
          : null;
      const container = trigger?.matches('.point-dates, .todo-date')
        ? trigger.closest<HTMLElement>('[data-space-id]')
        : trigger;
      const entry = snapshot.entries.find((e) => e.data.id === container?.dataset.spaceId);
      if (!trigger || !entry || !isSpaceItem(entry.data)) return;
      const date = trigger.matches('.point-dates, .todo-date');
      if (date && entry.data.type !== 'milestone' && entry.data.type !== 'todo') return;
      event.preventDefault();
      const rect = trigger.getBoundingClientRect();
      setMenu({
        entry,
        trigger,
        date,
        x: Math.max(
          8,
          Math.min(event instanceof MouseEvent ? event.clientX : rect.left + 16, innerWidth - 238),
        ),
        y: Math.max(
          8,
          Math.min(
            event instanceof MouseEvent ? event.clientY : rect.top + 16,
            innerHeight - (date ? 290 : 360),
          ),
        ),
      });
    };
    document.addEventListener('contextmenu', open);
    document.addEventListener('keydown', open);
    return () => {
      document.removeEventListener('contextmenu', open);
      document.removeEventListener('keydown', open);
    };
  }, [snapshot]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        (menu.trigger.querySelector('button') ?? menu.trigger).focus({ preventScroll: true });
        close();
      } else if (event.key === 'Tab') close();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);
  if (!menu || !isSpaceItem(menu.entry.data)) return null;
  const item = menu.entry.data;
  const pool = item.type === 'milestone' && item.pool;
  const today = localDay();
  const addDays = (days: number) => {
    const date = new Date(`${today}T12:00:00`);
    date.setDate(date.getDate() + days);
    return localDay(date);
  };
  const nextMonth = () => {
    const [year, month, day] = today.split('-').map(Number);
    const lastDay = new Date(year, month + 1, 0).getDate();
    return `${year + Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
  };
  const dateOptions = [
    ['今日', today],
    ['明日', addDays(1)],
    ['后日', addDays(2)],
    ['下周', addDays(7)],
    ['两周后', addDays(14)],
    ['下月', nextMonth()],
  ];
  return createPortal(
    <div
      className="space-context-menu"
      role="menu"
      aria-label={`${item.title} ${menu.date ? '日期快捷选项' : '操作'}`}
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
        ];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}
    >
      {!menu.date && <span title={item.title}>{item.title}</span>}
      {menu.date && !pool && (
        <>
          <span>设置日期</span>
          {dateOptions.map(([label, value]) => (
            <button
              key={label}
              role="menuitem"
              className="button"
              autoFocus={label === '今日'}
              onClick={() => {
                const updated = { ...item, dueDate: value };
                run(async () => {
                  await save(createRecord(item.type, updated), menu.entry);
                  await reload();
                });
                setMenu(null);
              }}
            >
              {label}
            </button>
          ))}
        </>
      )}
      {!menu.date && (
        <>
          {(item.type === 'todo' || item.type === 'milestone') && (
            <button
              role="menuitem"
              className="button"
              onClick={() => {
                edit({ type: item.type, entry: menu.entry, defaults: { comment: true } });
                setMenu(null);
              }}
            >
              添加批注
            </button>
          )}
          {!pool && (
            <button
              role="menuitem"
              className="button"
              onClick={() => {
                const complete = !isComplete(item, snapshot.entries);
                run(async () => {
                  await save(createRecord(item.type, item), menu.entry, { completion: complete });
                  await reload();
                });
                setMenu(null);
              }}
            >
              {isComplete(item, snapshot.entries) ? '重新打开' : '完成'}
              {item.type === 'todo' ? item.kind.toUpperCase() : spaceLabel[item.type]}
            </button>
          )}
          {!pool && (item.type === 'todo' || item.type === 'milestone') && (
            <button
              role="menuitem"
              className="button"
              onClick={() => {
                run(async () => {
                  await promote(menu.entry);
                  await reload();
                });
                setMenu(null);
              }}
            >
              升级为业务线
            </button>
          )}
        </>
      )}
      {!menu.date && !pool && (
        <button
          role="menuitem"
          className="button"
          autoFocus
          onClick={() => {
            edit({ type: item.type, entry: menu.entry });
            setMenu(null);
          }}
        >
          编辑{spaceLabel[item.type]}
        </button>
      )}
      {!menu.date && !pool && (
        <button
          role="menuitem"
          className="button danger"
          onClick={() => {
            remove(menu.entry);
            setMenu(null);
          }}
        >
          删除{spaceLabel[item.type]}
        </button>
      )}
    </div>,
    document.body,
  );
}
