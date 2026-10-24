import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { isSpaceItem, type Entry, type Snapshot } from '../../../../packages/domain/index';
import type { Editor } from './editor';
import { spaceLabel } from './WorkItemForm';

export function SpaceMenu({
  snapshot,
  edit,
  remove,
}: {
  snapshot: Snapshot;
  edit: (editor: Editor) => void;
  remove: (entry: Entry) => void;
}) {
  const [menu, setMenu] = useState<{
    entry: Entry;
    x: number;
    y: number;
    trigger: HTMLElement;
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
          ? event.target.closest<HTMLElement>('[data-space-id]')
          : null;
      const entry = snapshot.entries.find((e) => e.data.id === trigger?.dataset.spaceId);
      if (!trigger || !entry || !isSpaceItem(entry.data)) return;
      event.preventDefault();
      const rect = trigger.getBoundingClientRect();
      setMenu({
        entry,
        trigger,
        x: Math.max(
          8,
          Math.min(event instanceof MouseEvent ? event.clientX : rect.left + 16, innerWidth - 238),
        ),
        y: Math.max(
          8,
          Math.min(event instanceof MouseEvent ? event.clientY : rect.top + 16, innerHeight - 140),
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
  return createPortal(
    <div
      className="space-context-menu"
      role="menu"
      aria-label={`${item.title} 操作`}
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
      <span title={item.title}>{item.title}</span>
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
    </div>,
    document.body,
  );
}
