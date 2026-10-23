import { Cross2Icon, PlusIcon } from '@radix-ui/react-icons';
import {
  isSpaceItem,
  statusLabel,
  type Entry,
  type Snapshot,
} from '../../../../packages/domain/index';
import { todoStatus } from '../../../../packages/domain/workspace';
import { Button } from '../components/ui';
import { ImportanceDot } from '../components/Importance';
import { openObsidian, openResource } from '../api';
import type { Editor } from './editor';
import { spaceLabel } from './WorkItemForm';
export function SpaceDetails({
  entry,
  snapshot,
  edit,
  close,
  run,
}: {
  entry: Entry;
  snapshot: Snapshot;
  edit: (e: Editor) => void;
  close: () => void;
  run: (f: () => Promise<unknown>) => void;
}) {
  const item = entry.data;
  if (!isSpaceItem(item)) return null;
  const child =
    item.type === 'project'
      ? { type: 'workline' as const, defaults: { projectId: item.id } }
      : item.type === 'workline'
        ? { type: 'milestone' as const, defaults: { lineId: item.id } }
        : item.type === 'milestone'
          ? { type: 'todo' as const, defaults: { milestoneId: item.id } }
          : null;
  return (
    <aside className="detail" aria-label="工作详情">
      <div className="section-heading">
        <span className="eyebrow">
          {spaceLabel[item.type]} ·{' '}
          {statusLabel[item.type === 'todo' ? todoStatus(item, snapshot.entries) : item.status]}{' '}
          <ImportanceDot value={item.importance} />
        </span>
        <Button className="icon" aria-label="关闭详情" onClick={close}>
          <Cross2Icon />
        </Button>
      </div>
      <h2>{item.title}</h2>
      <div className="actions">
        <Button onClick={() => edit({ type: item.type, entry })}>编辑</Button>
        {child && (
          <Button onClick={() => edit(child)}>
            <PlusIcon />
            {spaceLabel[child.type]}
          </Button>
        )}
        <Button onClick={() => run(() => openObsidian(item.id))}>Obsidian ↗</Button>
      </div>
      {item.type === 'milestone' && (
        <p className="hint">
          截止 {item.dueDate ?? '日期未定'} {item.dueTime}
        </p>
      )}
      {item.description && <p className="preserve">{item.description}</p>}
      {item.type === 'todo' && (
        <p className="hint">
          {item.direction === 'self'
            ? '自己做'
            : `${item.direction === 'to' ? 'To' : 'From'} · ${item.person}`}
          {item.estimatedMinutes ? ` · ${item.estimatedMinutes} 分钟` : ''}
        </p>
      )}
      {item.type === 'todo' &&
        todoStatus(item, snapshot.entries) === 'Done' &&
        item.status !== 'Done' && (
          <p className="hint">已由实际工作记录联动完成。修改完成关联请到今日编辑该记录。</p>
        )}
      <section className="detail-section">
        <h3>资源</h3>
        {item.resourceIds.map((id) => {
          const resource = snapshot.entries.find((e) => e.data.id === id)?.data;
          return resource?.type === 'resource' ? (
            <button className="text-link" key={id} onClick={() => run(() => openResource(id))}>
              {resource.title} ↗
            </button>
          ) : null;
        })}
      </section>
    </aside>
  );
}
