import { DotsHorizontalIcon, PlusIcon } from '@radix-ui/react-icons';
import type { BusinessLine, Snapshot } from '../../../../../packages/domain/index';
import { Button, EmptyState } from '../../components/ui';
import { ImportanceDot } from '../../components/Importance';
import { workspaceGroups } from '../workspace/workspaceGroups';
import type { Editor } from '../../types/editor';

export function ProjectList({
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
    <div className="mobile-projects">
      {!groups.length && <EmptyState>{query ? '没有匹配的项目或业务线' : '还没有项目'}</EmptyState>}
      {groups.map(({ project, lines }) => (
        <section className="mobile-project" key={project.id} aria-label={`项目 · ${project.title}`}>
          <div className="mobile-project-heading">
            <h2>
              {project.title}
              {project.completedAt && <small> · 已结束</small>}
            </h2>
            <Button aria-label={`项目操作 · ${project.title}`} onClick={() => actions(project.id)}>
              <DotsHorizontalIcon />
            </Button>
          </div>
          <div className="mobile-project-lines">
            {lines.map((line) => (
              <button
                key={line.id}
                className="mobile-line-row"
                onClick={() => select(line)}
                aria-label={`打开业务线 ${line.title}`}
              >
                <ImportanceDot value={line.importance} />
                <span>{line.title}</span>
                {line.completedAt && <small>已结束</small>}
              </button>
            ))}
            <Button
              className="mobile-add-line"
              aria-label={`添加业务线 · ${project.title}`}
              onClick={() => edit({ type: 'workline', defaults: { projectId: project.id } })}
            >
              <PlusIcon />
            </Button>
          </div>
        </section>
      ))}
      <Button className="mobile-primary-add" onClick={() => edit({ type: 'project' })}>
        <PlusIcon />
        新建项目
      </Button>
    </div>
  );
}
