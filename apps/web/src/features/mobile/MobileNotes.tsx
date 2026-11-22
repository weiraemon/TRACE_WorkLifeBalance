import { type BusinessLine, type Snapshot } from '../../../../../packages/domain/index';
import { NotesContent } from '../workspace/NotesContent';

export function MobileNotes({
  snapshot,
  line,
  reload,
  onDirtyChange,
}: {
  snapshot: Snapshot;
  line: BusinessLine;
  reload: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const nodes = snapshot.entries.filter(
    (entry) =>
      entry.data.type === 'milestone' && entry.data.lineId === line.id && !entry.data.pool,
  );
  return (
    <section className="mobile-notes" aria-label={`笔记 · ${line.title}`}>
      {nodes.map((entry) => (
        entry.data.type === 'milestone' ? (
          <section className="mobile-note-entry" key={entry.data.id}>
            <NotesContent
              id={entry.data.id}
              title={entry.data.title}
              draftScope={snapshot.root}
              editable
              compact
              reload={reload}
              onDirtyChange={onDirtyChange}
            />
          </section>
        ) : null
      ))}
    </section>
  );
}
