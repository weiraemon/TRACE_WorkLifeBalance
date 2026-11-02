import { useRef, useState } from 'react';
import { PlusIcon } from '@radix-ui/react-icons';
import {
  isSpaceItem,
  localDay,
  type Milestone,
  type Snapshot,
  type SpaceItem,
  type Todo,
} from '../../../../packages/domain/index';
import {
  compareMilestones,
  shouldHideCompleted,
  isComplete,
} from '../../../../packages/domain/workspace';
import { complete } from '../api';
import { Button, EmptyState } from '../components/ui';
import type { Editor } from '../types/editor';
import { WorkspaceNavigation } from '../features/workspace/WorkspaceNavigation';
import { workspaceGroups } from '../features/workspace/workspaceGroups';
import { useWorkspaceDrag } from '../features/workspace/useWorkspaceDrag';
import { BusinessLineTrack } from '../features/workspace/BusinessLineTrack';
export function Workspace({
  snapshot,
  edit,
  select,
  reload,
  run,
  query,
  showArchived,
  onShowArchivedChange,
}: {
  snapshot: Snapshot;
  edit: (e: Editor) => void;
  select: (id: string) => void;
  reload: () => Promise<void>;
  run: (fn: () => Promise<unknown>) => void;
  query: string;
  showArchived: boolean;
  onShowArchivedChange: (show: boolean) => void;
}) {
  const [activeId, setActiveId] = useState('');
  const [showOlderNodes, setShowOlderNodes] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const drag = useWorkspaceDrag(snapshot, reload, run);
  const today = localDay();
  const records = snapshot.entries
    .map((e) => e.data)
    .filter(isSpaceItem)
    .filter(
      (item) =>
        showOlderNodes ||
        (item.type !== 'milestone' && item.type !== 'todo') ||
        !shouldHideCompleted(item, snapshot.entries, today),
    )
    .sort(
      (a, b) =>
        a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  const groups = workspaceGroups(snapshot.entries, showArchived, query);
  const jump = (id: string) => {
    setActiveId(id);
    content.current
      ?.querySelector<HTMLElement>(`[data-space-id="${id}"]`)
      ?.scrollIntoView({ block: 'start', inline: 'nearest' });
  };
  const toggle = (item: SpaceItem) =>
    run(async () => {
      const entry = snapshot.entries.find((e) => e.data.id === item.id)!;
      await complete(entry, !isComplete(item, snapshot.entries));
      await reload();
    });
  return (
    <div className="space-board">
      <WorkspaceNavigation
        groups={groups}
        activeId={activeId}
        onSelect={jump}
        showArchived={showArchived}
        onShowArchivedChange={onShowArchivedChange}
        showOlderNodes={showOlderNodes}
        onShowOlderNodesChange={setShowOlderNodes}
        onCreateProject={() => edit({ type: 'project' })}
      />
      <div className="workspace-content" ref={content} {...drag.boardProps}>
        <p className="workspace-drag-status" role="status">
          {drag.status}
        </p>
        {!groups.length && <EmptyState>{query ? '没有匹配的工作' : '暂无项目'}</EmptyState>}
        {groups.map(({ project, lines }) => (
          <section
            className="project-plane"
            key={project.id}
            data-space-id={project.id}
            {...drag.targetProps(project.id)}
            aria-label={`项目面 · ${project.title}`}
          >
            <div className="project-heading">
              <button className="project-title" onClick={() => select(project.id)}>
                <h2>{project.title}</h2>
              </button>
              <Button
                onClick={() => edit({ type: 'workline', defaults: { projectId: project.id } })}
              >
                <PlusIcon />
                业务线
              </Button>
            </div>
            <div className="plane-content">
              {lines.map((line) => {
                const points = records
                  .filter((r): r is Milestone => r.type === 'milestone' && r.lineId === line.id)
                  .sort(compareMilestones);
                return (
                  <BusinessLineTrack
                    key={line.id}
                    line={line}
                    points={points}
                    todos={records.filter((r): r is Todo => r.type === 'todo')}
                    snapshot={snapshot}
                    select={select}
                    edit={edit}
                    toggle={toggle}
                    drag={drag}
                  />
                );
              })}
              {!lines.length && <p className="plane-empty">暂无业务线</p>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
