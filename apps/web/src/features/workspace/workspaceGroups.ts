import {
  isSpaceItem,
  type Entry,
  type SpaceItem,
  type Project,
  type BusinessLine,
} from '../../../../../packages/domain/index';
export function workspaceGroups(entries: Entry[], showArchived: boolean, query: string) {
  const records = entries
    .map((e) => e.data)
    .filter(isSpaceItem)
    .sort(
      (a, b) =>
        a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  const live = (r: SpaceItem) => showArchived || !r.completedAt;
  const projects = records.filter((r): r is Project => r.type === 'project' && live(r));
  const groups = projects
    .map((project) => {
      const lines = records.filter(
        (r): r is BusinessLine => r.type === 'workline' && r.projectId === project.id && live(r),
      );
      const pointIds = new Set(
        records
          .filter((r) => r.type === 'milestone' && lines.some((l) => l.id === r.lineId))
          .map((r) => r.id),
      );
      const matches =
        !query ||
        [
          project,
          ...lines,
          ...records.filter(
            (r) => pointIds.has(r.id) || (r.type === 'todo' && pointIds.has(r.milestoneId)),
          ),
        ].some((r) => r.title.toLowerCase().includes(query));
      return { project, lines, matches };
    })
    .filter((group) => group.matches);
  return groups;
}
