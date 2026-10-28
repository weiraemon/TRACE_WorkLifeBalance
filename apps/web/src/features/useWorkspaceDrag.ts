import { useRef, useState, type DragEvent } from 'react';
import type { Entry, SaveOptions, Snapshot, SpaceItem } from '../../../../packages/domain/index';
import { save } from '../api';

type Placement = NonNullable<SaveOptions['move']>['placement'];
type Drop = { entry: Entry; placement: Placement };

export function useWorkspaceDrag(
  snapshot: Snapshot,
  reload: () => Promise<void>,
  run: (fn: () => Promise<unknown>) => void,
) {
  const dragging = useRef<{ entry: Entry; entries: Entry[] } | null>(null);
  const saving = useRef(false);
  const [sourceId, setSourceId] = useState('');
  const [drop, setDrop] = useState<Drop | null>(null);
  const [status, setStatus] = useState('');
  const clear = () => {
    dragging.current = null;
    setSourceId('');
    setDrop(null);
  };
  const findDrop = (event: DragEvent<HTMLDivElement>): Drop | null => {
    const source = dragging.current;
    if (!source || !(event.target instanceof Element)) return null;
    let element = event.target.closest<HTMLElement>('[data-space-id]');
    while (element && event.currentTarget.contains(element)) {
      const entry = source.entries.find((e) => e.data.id === element!.dataset.spaceId);
      const item = source.entry.data;
      const target = entry?.data;
      if (target?.id === item.id) return null;
      if (entry && target) {
        if (
          (item.type === 'workline' && target.type === 'workline') ||
          (item.type === 'todo' && target.type === 'todo')
        ) {
          const rect = element.getBoundingClientRect();
          return {
            entry,
            placement: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
          };
        }
        if (
          (item.type === 'workline' && target.type === 'project') ||
          (item.type === 'milestone' && target.type === 'workline') ||
          (item.type === 'todo' && target.type === 'milestone')
        )
          return { entry, placement: 'inside' };
      }
      element = element.parentElement?.closest<HTMLElement>('[data-space-id]') ?? null;
    }
    return null;
  };
  return {
    status,
    sourceProps: (item: SpaceItem) => ({
      draggable: item.type !== 'project' && !(item.type === 'milestone' && item.pool),
      'data-drag-id': item.id,
      title: `${item.title} · 拖动标题可移动${item.type === 'milestone' ? '到其他业务线' : '或排序'}`,
    }),
    targetProps: (id: string) => ({
      'data-dragging': sourceId === id || undefined,
      'data-drop-position': drop?.entry.data.id === id ? drop.placement : undefined,
    }),
    boardProps: {
      onDragStart: (event: DragEvent<HTMLDivElement>) => {
        const id = (event.target as HTMLElement).closest<HTMLElement>('[data-drag-id]')?.dataset
          .dragId;
        const entry = snapshot.entries.find((e) => e.data.id === id);
        if (
          saving.current ||
          !entry ||
          entry.data.type === 'project' ||
          (entry.data.type === 'milestone' && entry.data.pool)
        ) {
          event.preventDefault();
          return;
        }
        dragging.current = { entry, entries: snapshot.entries };
        setSourceId(entry.data.id);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', entry.data.id);
      },
      onDragOver: (event: DragEvent<HTMLDivElement>) => {
        const next = findDrop(event);
        if (next) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }
        setDrop((current) =>
          current?.entry.data.id === next?.entry.data.id && current?.placement === next?.placement
            ? current
            : next,
        );
      },
      onDragLeave: (event: DragEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
      },
      onDragEnd: clear,
      onDrop: (event: DragEvent<HTMLDivElement>) => {
        const source = dragging.current?.entry;
        const target = findDrop(event);
        clear();
        if (!source || !target) return;
        event.preventDefault();
        saving.current = true;
        setStatus('正在保存移动…');
        run(async () => {
          try {
            const result = await save(source.data, source, {
              move: {
                targetId: target.entry.data.id,
                revision: target.entry.revision,
                placement: target.placement,
              },
            });
            await reload();
            const moved = result.data;
            const destination =
              moved.type === 'todo' &&
              snapshot.entries.find((e) => e.data.id === moved.milestoneId)?.data;
            setStatus(
              destination && destination.type === 'milestone' && destination.pool
                ? '已移入待办池；保留条目日期和批注'
                : '已保存移动',
            );
          } catch (error) {
            setStatus('移动或刷新失败，请检查错误提示后重新加载');
            throw error;
          } finally {
            saving.current = false;
          }
        });
      },
    },
  };
}
