import { Cross2Icon, PlusIcon } from '@radix-ui/react-icons';
import { isSpaceItem, type Entry, type Snapshot } from '../../../../packages/domain/index';
import { lineFor, isComplete } from '../../../../packages/domain/workspace';
import { Button } from '../components/ui';
import { ImportanceDot } from '../components/Importance';
import { openResource } from '../api';
import type { Editor } from './editor';
import { spaceLabel } from './WorkItemForm';
import { NotesContent } from './NotesContent';
export function SpaceDetails({
  entry,
  snapshot,
  edit,
  close,
  run,
  reload,
  onDirtyChange,
}: {
  entry: Entry;
  snapshot: Snapshot;
  edit: (e: Editor) => void;
  close: () => void;
  run: (f: () => Promise<unknown>) => void;
  reload: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const item = entry.data;
  if (!isSpaceItem(item)) return null;
  const line = lineFor(item, snapshot.entries);
  const note = snapshot.entries.find((e) => e.data.id === line?.notesId);
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
          {item.type === 'todo' ? item.kind.toUpperCase() : spaceLabel[item.type]}
          {isComplete(item, snapshot.entries) ? ' · 已完成' : ''}{' '}
          <ImportanceDot value={item.importance} />
        </span>
        <Button className="icon" aria-label="关闭详情" onClick={close}>
          <Cross2Icon />
        </Button>
      </div>
      <h2 data-space-id={item.id} tabIndex={0}>
        {item.title}
      </h2>
      <div className="actions">
        {child && (
          <Button onClick={() => edit(child)}>
            <PlusIcon />
            {child.type === 'todo' ? 'TODO' : spaceLabel[child.type]}
          </Button>
        )}
        {item.type === 'milestone' && (
          <Button
            onClick={() => edit({ type: 'todo', defaults: { milestoneId: item.id, kind: 'idea' } })}
          >
            <PlusIcon />
            IDEA
          </Button>
        )}
        {item.type === 'workline' && item.notesId && (
          <Button onClick={() => run(() => openResource(item.notesId!))}>打开 Notes ↗</Button>
        )}
      </div>
      {item.type === 'milestone' && !item.pool && (
        <p>
          {item.dueDate ?? '未定日期'} {item.dueTime} {item.tags.join(' · ')}
        </p>
      )}
      {item.type === 'todo' && (
        <p>
          {item.dueDate}{' '}
          {item.direction !== 'self'
            ? `${item.direction === 'from' ? '等' : '找'} ${item.person}`
            : ''}
        </p>
      )}
      {line && (
        <NotesContent
          key={snapshot.vaultId + item.id}
          id={item.id}
          revision={note?.revision}
          editable={item.type === 'workline'}
          reload={reload}
          onDirtyChange={onDirtyChange}
        />
      )}
      {item.resourceIds.length > 0 && (
        <section className="detail-section">
          <h3>资料</h3>
          {item.resourceIds.map((id) => {
            const data = snapshot.entries.find((e) => e.data.id === id)?.data;
            return data?.type === 'resource' ? (
              <button className="text-link" key={id} onClick={() => run(() => openResource(id))}>
                {data.title} ↗
              </button>
            ) : null;
          })}
        </section>
      )}
    </aside>
  );
}
