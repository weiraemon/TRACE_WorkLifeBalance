import { useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from '@radix-ui/react-icons';
import type { workspaceGroups } from './workspaceGroups';
import { ImportanceDot } from '../../components/Importance';
import { Button } from '../../components/ui';

export function WorkspaceNavigation({
  groups,
  activeId,
  onSelect,
  showArchived,
  onShowArchivedChange,
  onCreateProject,
  showOlderNodes,
  onShowOlderNodesChange,
}: {
  groups: ReturnType<typeof workspaceGroups>;
  activeId: string;
  onSelect: (id: string) => void;
  showArchived: boolean;
  onShowArchivedChange: (show: boolean) => void;
  onCreateProject?: () => void;
  showOlderNodes?: boolean;
  onShowOlderNodesChange?: (show: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  return (
    <nav className="workspace-nav" aria-label="业务导航">
      <div className="workspace-nav-tree">
        <ul>
          {groups.map(({ project, lines }) => {
            const folded = collapsed.has(project.id);
            return (
              <li key={project.id} data-space-id={project.id}>
                <div className="workspace-nav-project">
                  <button
                    className="workspace-nav-toggle"
                    aria-expanded={!folded}
                    aria-label={`${folded ? '展开' : '收缩'}项目 ${project.title}`}
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (folded) next.delete(project.id);
                        else next.add(project.id);
                        return next;
                      })
                    }
                  >
                    {folded ? <ChevronRightIcon /> : <ChevronDownIcon />}
                  </button>
                  <button
                    aria-current={activeId === project.id ? 'location' : undefined}
                    aria-label={`定位项目 · ${project.title}`}
                    onClick={() => onSelect(project.id)}
                    title={project.title}
                  >
                    <span>{project.title}</span>
                  </button>
                </div>
                {!folded && (
                  <ul>
                    {lines.map((line) => (
                      <li key={line.id} data-space-id={line.id}>
                        <button
                          aria-current={activeId === line.id ? 'location' : undefined}
                          aria-label={`定位业务线 · ${line.title}`}
                          onClick={() => onSelect(line.id)}
                          title={line.title}
                        >
                          <ImportanceDot value={line.importance} />
                          <span>{line.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="workspace-nav-actions">
        {onShowOlderNodesChange && (
          <label className="check-label">
            <input
              type="checkbox"
              checked={showOlderNodes ?? false}
              onChange={(event) => onShowOlderNodesChange(event.target.checked)}
            />
            显示较早已完成节点
          </label>
        )}
        <label className="check-label">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => onShowArchivedChange(e.target.checked)}
          />
          显示已完成项目 / 业务线
        </label>
        {onCreateProject && (
          <Button onClick={onCreateProject}>
            <PlusIcon />
            新增项目
          </Button>
        )}
      </div>
    </nav>
  );
}
