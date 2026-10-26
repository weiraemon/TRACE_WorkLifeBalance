import { useState } from 'react';
import type { Snapshot } from '../../../../packages/domain/index';
import { EmptyState } from '../components/ui';
import { NotesContent } from '../features/NotesContent';
import { WorkspaceNavigation, workspaceGroups } from '../features/WorkspaceNavigation';

export function Knowledge({
  snapshot,
  query,
  showArchived,
  onShowArchivedChange,
}: {
  snapshot: Snapshot;
  query: string;
  showArchived: boolean;
  onShowArchivedChange: (show: boolean) => void;
}) {
  const [lineId, setLineId] = useState('');
  const groups = workspaceGroups(snapshot.entries, showArchived, query);
  const line = groups.flatMap((group) => group.lines).find((line) => line.id === lineId);
  const note = snapshot.entries.find((e) => e.data.id === line?.notesId);
  return (
    <div className="space-board">
      <WorkspaceNavigation
        groups={groups}
        activeId={line?.id ?? ''}
        onSelect={(id) => {
          const project = groups.find((group) => group.project.id === id);
          setLineId(project ? (project.lines[0]?.id ?? '') : id);
        }}
        showArchived={showArchived}
        onShowArchivedChange={onShowArchivedChange}
      />
      <div className="workspace-content knowledge-content" role="region" aria-label="业务线 Notes">
        {line ? (
          <NotesContent
            key={snapshot.vaultId + line.id}
            id={line.id}
            revision={note?.revision}
            editable
          />
        ) : (
          <EmptyState>
            {!groups.length ? (query ? '没有匹配的工作' : '暂无项目') : '选择一条业务线查看 Notes'}
          </EmptyState>
        )}
      </div>
    </div>
  );
}
