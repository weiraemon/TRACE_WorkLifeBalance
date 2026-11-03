import { PlusIcon } from '@radix-ui/react-icons';
import type { BusinessLine, Snapshot } from '../../../../../packages/domain/index';
import { Button, EmptyState } from '../../components/ui';
import { workspaceGroups } from '../workspace/workspaceGroups';
import type { Editor } from '../../types/editor';

export function ProjectOrbit({
  snapshot,
  query,
  archived,
  select,
  edit,
  actions,
}: {
  snapshot: Snapshot;
  query: string;
  archived: boolean;
  select: (line: BusinessLine) => void;
  edit: (editor: Editor) => void;
  actions: (id: string) => void;
}) {
  const groups = workspaceGroups(snapshot.entries, archived, query.toLowerCase());
  return (
    <div className="mobile-orbits">
      {!groups.length && (
        <EmptyState>
          {query ? '没有匹配的项目或业务线' : '从一个项目开始，把下一步放到业务线上。'}
        </EmptyState>
      )}
      {groups.map(({ project, lines }) => {
        // Four readable satellites per orbit; more lines extend the page, never shrink labels.
        const rings = Array.from({ length: Math.max(1, Math.ceil(lines.length / 4)) }, (_, index) =>
          lines.slice(index * 4, index * 4 + 4),
        );
        return (
          <section
            className="mobile-project"
            key={project.id}
            aria-label={`项目 · ${project.title}`}
          >
            <div className="mobile-project-heading">
              <span>{project.completedAt ? '已结束项目' : '项目'}</span>
              <Button
                aria-label={`项目操作 · ${project.title}`}
                onClick={() => actions(project.id)}
              >
                更多
              </Button>
            </div>
            {rings.map((ring, index) => (
              <div className="mobile-orbit" key={index}>
                <svg
                  className="mobile-orbit-links"
                  viewBox="0 0 360 320"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  {ring.map((line, slot) => (
                    <line
                      key={line.id}
                      x1="180"
                      y1="160"
                      x2={slot % 2 ? 280 : 80}
                      y2={slot < 2 ? 59 : 261}
                    />
                  ))}
                </svg>
                <button
                  className="mobile-project-core"
                  onClick={() => actions(project.id)}
                  aria-label={`查看项目 ${project.title}`}
                >
                  <span>{project.title}</span>
                  {index > 0 && <small>续 {index + 1}</small>}
                </button>
                {ring.map((line, slot) => (
                  <button
                    key={line.id}
                    className={`mobile-line-orb slot-${slot} priority-${line.importance}`}
                    onClick={() => select(line)}
                    aria-label={`打开业务线 ${line.title}`}
                  >
                    <span>{line.title}</span>
                    <small>{line.completedAt ? '已结束' : '进入业务线'}</small>
                  </button>
                ))}
                {!ring.length && <span className="mobile-orbit-empty">还没有业务线</span>}
              </div>
            ))}
            <Button
              className="mobile-add-line"
              onClick={() => edit({ type: 'workline', defaults: { projectId: project.id } })}
            >
              <PlusIcon />
              添加业务线
            </Button>
          </section>
        );
      })}
      <Button className="mobile-primary-add" onClick={() => edit({ type: 'project' })}>
        <PlusIcon />
        新建项目
      </Button>
    </div>
  );
}
