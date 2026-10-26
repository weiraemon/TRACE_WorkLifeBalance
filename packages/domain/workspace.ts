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
export function activeLines(entries: Entry[]): BusinessLine[] {
  const closedProjects = new Set(
    entries.flatMap(({ data }) => (data.type === 'project' && data.completedAt ? [data.id] : [])),
  );
  return entries.flatMap(({ data }) =>
    data.type === 'workline' && !data.completedAt && !closedProjects.has(data.projectId)
      ? [data]
      : [],
  );
}
export const overdueTodos = (entries: Entry[], today = localDay()) =>
  todoContexts(entries)
    .filter((c) => {
      const due = todoDate(c);
      return (
        c.todo.kind === 'todo' &&
        !c.todo.completedAt &&
        !c.line.completedAt &&
        !c.project.completedAt &&
        due !== null &&
        due < today
      );
    })
    .sort((a, b) => todoDate(a)!.localeCompare(todoDate(b)!) || a.todo.id.localeCompare(b.todo.id));
export function isComplete(record: RecordData, entries: Entry[]): boolean {
  if (!isSpaceItem(record)) return false;
  if (record.type === 'milestone') {
    if (record.pool) return false;
    const children = entries
      .map((e) => e.data)
      .filter((r): r is Todo => r.type === 'todo' && r.milestoneId === record.id);
    if (children.length) return children.every((r) => Boolean(r.completedAt));
  }
  return Boolean(record.completedAt);
}
export function lineFor(record: RecordData, entries: Entry[]): BusinessLine | undefined {
  if (record.type === 'workline') return record;
  const point =
    record.type === 'todo' ? entries.find((e) => e.data.id === record.milestoneId)?.data : record;
  const line =
    point?.type === 'milestone' ? entries.find((e) => e.data.id === point.lineId)?.data : undefined;
  return line?.type === 'workline' ? line : undefined;
}
export function compareMilestones(a: Milestone, b: Milestone) {
  if (a.pool !== b.pool) return a.pool ? 1 : -1;
  if (!a.dueDate || !b.dueDate) {
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  }
  return (
    a.dueDate.localeCompare(b.dueDate) ||
    (a.dueTime ?? '23:59').localeCompare(b.dueTime ?? '23:59') ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}
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
    .filter((c) => !isComplete(c.todo, entries) && !c.project.completedAt && !c.line.completedAt)
    .sort(
      (a, b) =>
        b.todo.importance - a.todo.importance ||
        bucket(todoDate(a)) - bucket(todoDate(b)) ||
        b.milestone.importance - a.milestone.importance ||
        b.line.importance - a.line.importance ||
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
export const todosForDay = (entries: Entry[], date = localDay()) => {
  const open = recentTodos(entries, date).filter((c) => todoDate(c) === date);
  const completed = todoContexts(entries).filter(
    (c) =>
      todoDate(c) === date &&
      isComplete(c.todo, entries) &&
      !c.project.completedAt &&
      !c.line.completedAt,
  );
  const weight = (context: TodoContext) => {
    if (isComplete(context.todo, entries)) return 0;
    const urgency = daysAway(context.milestone.dueDate, date);
    return (
      context.line.importance +
      context.todo.importance +
      (urgency === null
        ? 0
        : urgency <= 0
          ? 5
          : urgency === 1
            ? 4
            : urgency === 2
              ? 3
              : urgency <= 7
                ? 2
                : 1)
    );
  };
  return [...open, ...completed].sort(
    (a, b) =>
      weight(b) - weight(a) ||
      (a.milestone.dueDate ?? '9999-12-31').localeCompare(b.milestone.dueDate ?? '9999-12-31') ||
      (a.milestone.dueTime ?? '23:59').localeCompare(b.milestone.dueTime ?? '23:59') ||
      a.todo.createdAt.localeCompare(b.todo.createdAt) ||
      a.todo.id.localeCompare(b.todo.id),
  );
};
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
      if (milestone.type !== 'milestone' || milestone.pool || !isForDay({ milestone }, date))
        return [];
      const line = records.get(milestone.lineId);
      const project = line?.type === 'workline' ? records.get(line.projectId) : null;
      return line?.type === 'workline' &&
        project?.type === 'project' &&
        !line.completedAt &&
        !project.completedAt
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
