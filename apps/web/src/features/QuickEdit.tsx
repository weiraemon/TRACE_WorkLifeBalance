import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isSpaceItem, type Entry, type Snapshot } from '../../../../packages/domain/index';
import { createRecord, save } from '../api';
import { ImportancePicker } from '../components/Importance';
import { ErrorMessage } from '../components/ui';

type Target = {
  id: string;
  trigger: HTMLElement;
  x: number;
  y: number;
};
const triggers = '.importance-dot, .point-dot, .todo-check:not(:disabled), .line-importance';

export function QuickEdit({
  snapshot,
  reload,
}: {
  snapshot: Snapshot;
  reload: () => Promise<void>;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const current = useRef(target);
  current.current = target;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const cancel = () => clearTimeout(timer);
    const close = () => {
      cancel();
      setTarget(null);
    };
    const find = (element: EventTarget | null) => {
      if (!(element instanceof Element)) return null;
      const trigger = element.closest<HTMLElement>(triggers);
      const container = trigger?.closest<HTMLElement>('[data-space-id]');
      const entry = snapshot.entries.find((e) => e.data.id === container?.dataset.spaceId);
      if (
        !trigger ||
        !entry ||
        !isSpaceItem(entry.data) ||
        entry.data.type === 'project' ||
        (entry.data.type === 'milestone' && entry.data.pool)
      )
        return null;
      const rect = trigger.getBoundingClientRect();
      return {
        id: entry.data.id,
        trigger,
        x: Math.max(8, Math.min(rect.left, innerWidth - 288)),
        y: Math.max(8, Math.min(rect.bottom + 6, innerHeight - 88)),
      } satisfies Target;
    };
    const open = (value: Target) => {
      cancel();
      if (current.current?.id !== value.id || current.current?.trigger !== value.trigger)
        setTarget(value);
    };
    const hover = (event: PointerEvent) => {
      cancel();
      if (
        event.pointerType === 'touch' ||
        panel.current?.contains(event.target as Node) ||
        panel.current?.contains(document.activeElement)
      )
        return;
      const value = find(event.target);
      timer = setTimeout(() => (value ? open(value) : setTarget(null)), 180);
    };
    const focus = (event: FocusEvent) => {
      cancel();
      if (panel.current?.contains(event.target as Node)) return;
      const value = find(event.target);
      if (value) open(value);
      else setTarget(null);
    };
    const click = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('.point-dot, .todo-check')) {
        close();
        return;
      }
      if (!event.target.closest('.importance-dot, .line-importance')) return;
      const value = find(event.target);
      if (!value) return;
      event.preventDefault();
      event.stopPropagation();
      open(value);
      requestAnimationFrame(() =>
        panel.current?.querySelector<HTMLElement>('button, input')?.focus(),
      );
    };
    const outside = (event: Event) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !current.current?.trigger.contains(event.target as Node)
      )
        close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && current.current) {
        event.preventDefault();
        current.current.trigger.focus({ preventScroll: true });
        close();
      } else if (
        event.key === 'ArrowDown' &&
        current.current &&
        !panel.current?.contains(event.target as Node)
      ) {
        event.preventDefault();
        panel.current?.querySelector<HTMLElement>('button, input')?.focus();
      }
    };
    document.addEventListener('contextmenu', close);
    document.addEventListener('pointerover', hover);
    document.addEventListener('focusin', focus);
    document.addEventListener('click', click, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', outside, true);
    window.addEventListener('resize', close);
    return () => {
      cancel();
      document.removeEventListener('contextmenu', close);
      document.removeEventListener('pointerover', hover);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('click', click, true);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', close);
    };
  }, [snapshot]);
  const entry = snapshot.entries.find((e) => e.data.id === target?.id);
  if (!target || !entry || !isSpaceItem(entry.data)) return null;
  return createPortal(
    <div
      className="quick-editor"
      role="region"
      aria-label={`快捷调整 · ${entry.data.title}`}
      ref={panel}
      style={{ left: target.x, top: target.y }}
    >
      <QuickEditFields
        key={entry.data.id}
        entry={entry}
        reload={reload}
        close={() => setTarget(null)}
      />
    </div>,
    document.body,
  );
}

function QuickEditFields({
  entry,
  reload,
  close,
}: {
  entry: Entry;
  reload: () => Promise<void>;
  close: () => void;
}) {
  const [original] = useState(entry);
  const item = original.data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!isSpaceItem(item)) return null;
  const update = async (fields: object) => {
    setBusy(true);
    setError('');
    try {
      await save(createRecord(item.type, { ...item, ...fields }), original);
      await reload();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <fieldset disabled={busy}>
        <ImportancePicker
          value={item.importance}
          onChange={(importance) => void update({ importance })}
        />
      </fieldset>
      <ErrorMessage message={error} />
    </>
  );
}
