import {
  localDay,
  minutes,
  isSpaceItem,
  type Entry,
  type RecordData,
  type Todo,
  type Milestone,
  type BusinessLine,
  type Project,
} from './index';

export type MilestoneContext = {
  milestone: Milestone;
  line: BusinessLine;
  project: Project;
};
export type TodoContext = MilestoneContext & { todo: Todo };
export const todoDate = (context: TodoContext) => context.todo.dueDate ?? context.milestone.dueDate;
export const compareMilestones = (a: Milestone, b: Milestone) =>
  (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') ||
  (a.dueTime ?? '23:59').localeCompare(b.dueTime ?? '23:59') ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.id.localeCompare(b.id);
export function milestoneTimeOnDay(milestone: Milestone, date: string) {
  return milestone.dueDate === date && milestone.dueTime ? minutes(milestone.dueTime) : null;
}
export function todoContexts(entries: Entry[]): TodoContext[] {
  const records = new Map(entries.map((e) => [e.data.id, e.data]));
  return entries.flatMap(({ data: todo }) => {
    if (todo.type !== 'todo') return [];
    const milestone = records.get(todo.milestoneId);
    const line = milestone?.type === 'milestone' ? records.get(milestone.lineId) : null;
    const project = line?.type === 'workline' ? records.get(line.projectId) : null;
    return milestone?.type === 'milestone' &&
      line?.type === 'workline' &&
      project?.type === 'project'
      ? [{ todo, milestone, line, project }]
      : [];
  });
}
export function todoStatus(todo: Todo, entries: Entry[]) {
  if (todo.status === 'Cancelled') return 'Cancelled';
  return entries.some((e) => e.data.type === 'actual' && e.data.completedTodoIds.includes(todo.id))
    ? 'Done'
    : todo.status;
}
export function daysAway(date: string | null, today = localDay()) {
  return date
    ? Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000)
    : null;
}
export function dueLabel(date: string | null, today = localDay()) {
  const days = daysAway(date, today);
  return days === null
    ? '节点未定日期'
    : days < 0
      ? `已过期 ${-days} 天`
      : days === 0
        ? '今天'
        : days === 1
          ? '明天'
          : days === 2
            ? '后天'
            : date!;
}
export function recentTodos(entries: Entry[], today = localDay()) {
  const bucket = (date: string | null) => {
    const days = daysAway(date, today);
    return days === null ? 100000 : Math.max(-1, days);
  };
  return todoContexts(entries)
    .filter(
      (c) =>
        !['Done', 'Cancelled'].includes(todoStatus(c.todo, entries)) &&
        ![c.project, c.line, c.milestone].some((r) => ['Done', 'Cancelled'].includes(r.status)),
    )
    .sort(
      (a, b) =>
        b.todo.importance - a.todo.importance ||
        bucket(todoDate(a)) - bucket(todoDate(b)) ||
        b.milestone.importance - a.milestone.importance ||
        b.line.importance - a.line.importance ||
        (a.todo.estimatedMinutes ?? 30) - (b.todo.estimatedMinutes ?? 30) ||
        a.todo.createdAt.localeCompare(b.todo.createdAt) ||
        a.todo.id.localeCompare(b.todo.id),
    );
}
export function contactGroups(entries: Entry[], today = localDay()) {
  const groups = new Map<string, TodoContext[]>();
  for (const context of recentTodos(entries, today).filter((c) => c.todo.direction !== 'self')) {
    const list = groups.get(context.todo.person) ?? [];
    list.push(context);
    groups.set(context.todo.person, list);
  }
  return [...groups].map(([person, todos]) => ({ person, todos }));
}
export const spaceParentId = (record: RecordData) =>
  record.type === 'workline'
    ? record.projectId
    : record.type === 'milestone'
      ? record.lineId
      : record.type === 'todo'
        ? record.milestoneId
        : null;
export function spaceSubtree(entries: Entry[], id: string): Entry[] {
  if (!entries.some((e) => e.data.id === id && isSpaceItem(e.data))) return [];
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { data } of entries) {
      const parent = spaceParentId(data);
      if (isSpaceItem(data) && parent && ids.has(parent) && !ids.has(data.id)) {
        ids.add(data.id);
        changed = true;
      }
    }
  }
  return entries.filter((e) => isSpaceItem(e.data) && ids.has(e.data.id));
}
export function isForDay(context: Pick<MilestoneContext, 'milestone'>, date: string) {
  return context.milestone.dueDate === date;
}
export const todosForDay = (entries: Entry[], date = localDay()) =>
  recentTodos(entries, date).filter((c) => todoDate(c) === date);
export const contactsForDay = (entries: Entry[], date = localDay()) =>
  contactGroups(entries, date)
    .map((g) => ({
      ...g,
      todos: g.todos.filter((c) => {
        const due = todoDate(c);
        return due !== null && due <= date;
      }),
    }))
    .filter((g) => g.todos.length);

export function milestonesForDay(entries: Entry[], date = localDay()): MilestoneContext[] {
  const records = new Map(entries.map((e) => [e.data.id, e.data]));
  return entries
    .flatMap(({ data: milestone }) => {
      if (
        milestone.type !== 'milestone' ||
        milestone.status === 'Cancelled' ||
        !isForDay({ milestone }, date)
      )
        return [];
      const line = records.get(milestone.lineId);
      const project = line?.type === 'workline' ? records.get(line.projectId) : null;
      return line?.type === 'workline' &&
        project?.type === 'project' &&
        line.status !== 'Cancelled' &&
        project.status !== 'Cancelled'
        ? [{ milestone, line, project }]
        : [];
    })
    .sort(
      (a, b) =>
        a.project.order - b.project.order ||
        a.project.id.localeCompare(b.project.id) ||
        a.line.order - b.line.order ||
        a.line.id.localeCompare(b.line.id) ||
        compareMilestones(a.milestone, b.milestone),
    );
}
