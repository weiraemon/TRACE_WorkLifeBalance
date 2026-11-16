import { useEffect, useRef, type PointerEvent, type MouseEvent, type KeyboardEvent } from 'react';

export function useContextActions(open: (id: string) => void) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const consumed = useRef(false);
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => cancel, []);
  const target = (element: EventTarget | null) =>
    element instanceof Element
      ? element.closest<HTMLElement>('[data-space-id]')?.dataset.spaceId
      : undefined;
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      cancel();
      consumed.current = false;
      if (
        event.pointerType === 'mouse' ||
        (event.target as Element).closest('input, textarea, select, .button, [role="checkbox"]')
      )
        return;
      const id = target(event.target);
      if (!id) return;
      press.current = {
        x: event.clientX,
        y: event.clientY,
        timer: setTimeout(() => {
          press.current = null;
          consumed.current = true;
          open(id);
        }, 500),
      };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (
        press.current &&
        Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8
      )
        cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (!consumed.current) return;
      event.preventDefault();
      event.stopPropagation();
      consumed.current = false;
    },
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      const id = target(event.target);
      if (!id || (event.target as Element).closest('input, textarea, select')) return;
      event.preventDefault();
      cancel();
      open(id);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const id = target(event.target);
      if (id && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        event.preventDefault();
        open(id);
      }
    },
  };
}
