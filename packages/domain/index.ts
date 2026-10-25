import { z } from 'zod';
export const recordContract = 'atlas-lines-10';
export const noteKinds = ['note', 'idea', 'meeting', 'draft'] as const;
export const noteKindLabel = { note: '笔记', idea: '灵感', meeting: '纪要', draft: '待细化' };
export const noteTagSchema = z
  .string()
  .trim()
  .max(60)
  .refine(
    (value) =>
      !value ||
      (!/[<>:"/\\|?*\x00-\x1f]/.test(value) &&
        !/[. ]$/.test(value) &&
        !/^(\.git|\.obsidian|\.atlas|node_modules)$/i.test(value) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)),
    '标签不能包含路径分隔符、特殊文件名或末尾句点',
  );
export const noteInputSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    kind: z.enum(noteKinds).default('note'),
    tag: noteTagSchema.default(''),
  })
  .strict();
export const milestoneTags = ['会议', '讨论', '专注', '实验', '审阅'];
export const directionLabel = { self: '自己做', to: '交给他人 · To', from: '等待他人 · From' };
const id = z.string().uuid();
export const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
    '无效日期',
  );
const optionalDay = day.nullable().default(null);
export const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/);
const text = z.string().max(20000);
const base = {
  schemaVersion: z.literal(1),
  id,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};
export const importanceSchema = z.number().int().min(1).max(5);
const workFields = {
  ...base,
  title: z.string().trim().min(1).max(300),
  completedAt: z.iso.datetime().nullable().default(null),
  importance: importanceSchema.default(3),
  order: z.number().finite().default(0),
  resourceIds: z.array(id).default([]),
};
const projectSchema = z.object({ ...workFields, type: z.literal('project') }).strict();
const lineSchema = z
  .object({
    ...workFields,
    type: z.literal('workline'),
    projectId: id,
    notesId: id.nullable().default(null),
  })
  .strict();
const milestoneSchema = z
  .object({
    ...workFields,
    type: z.literal('milestone'),
    lineId: id,
    pool: z.boolean().default(false),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    dueDate: optionalDay,
    dueTime: time
      .refine((value) => value !== '24:00', '截止时刻请使用 00:00–23:59')
      .nullable()
      .default(null),
  })
  .strict();
const todoSchema = z
  .object({
    ...workFields,
    type: z.literal('todo'),
    milestoneId: id,
    kind: z.enum(['todo', 'idea']).default('todo'),
    dueDate: optionalDay,
    direction: z.enum(['self', 'to', 'from']).default('self'),
    person: z.string().trim().max(200).default(''),
  })
  .strict();
const actualSchema = z
  .object({
    ...base,
    type: z.literal('actual'),
    date: day,
    startTime: time,
    endTime: time,
    description: text.trim().min(1),
    itemIds: z.array(id).default([]),
  })
  .strict();
const resourceSchema = z
  .object({
    ...base,
    type: z.literal('resource'),
    title: z.string().trim().min(1).max(300),
    target: z.string().min(1).max(2000),
    location: z.enum(['vault', 'url', 'external']),
    fingerprint: z.string().nullable().default(null),
    noteId: id.nullable().default(null),
    kind: z.enum(noteKinds).default('note'),
    tag: noteTagSchema.default(''),
  })
  .strict();
const reviewSchema = z
  .object({
    ...base,
    type: z.literal('review'),
    week: day,
    mainline: text.default(''),
    outcomes: text.default(''),
    reflection: text.default(''),
    nextWeek: text.default(''),
  })
  .strict();
export const recordSchema = z.discriminatedUnion('type', [
  projectSchema,
  lineSchema,
  milestoneSchema,
  todoSchema,
  actualSchema,
  resourceSchema,
  reviewSchema,
]);
export type RecordData = z.infer<typeof recordSchema>;
export type Project = Extract<RecordData, { type: 'project' }>;
export type BusinessLine = Extract<RecordData, { type: 'workline' }>;
export type Milestone = Extract<RecordData, { type: 'milestone' }>;
export type Todo = Extract<RecordData, { type: 'todo' }>;
export type ActualRecord = Extract<RecordData, { type: 'actual' }>;
export const saveOptionsSchema = z
  .object({
    completion: z.boolean().optional(),
    newItems: z.array(todoSchema).max(50).default([]),
    completeIds: z.array(id).max(100).default([]),
    comments: z
      .array(
        z
          .object({
            id,
            targetId: id,
            text: text
              .trim()
              .min(1)
              .refine((value) => !/<!--\s*\/?atlas:/i.test(value), '批注不能包含系统段落标记'),
            date: day.optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export type SaveOptions = z.input<typeof saveOptionsSchema>;
export type SpaceItem = Project | BusinessLine | Milestone | Todo;
export const isSpaceItem = (record: RecordData): record is SpaceItem =>
  ['project', 'workline', 'milestone', 'todo'].includes(record.type);
export type Entry = { data: RecordData; path: string; revision: string };
export type DeletePreview = { entries: Entry[]; blockedReason: string | null };
export type DeleteResult = { deletedIds: string[] };
export type NoteContent = { body: string; revision: string; path: string };
export type Snapshot = {
  entries: Entry[];
  files: { path: string; directory: boolean }[];
  issues: { path: string; message: string }[];
  root: string;
  vaultId: string;
};
export const localDay = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const weekStart = (date = localDay()) => {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDay(d);
};
export const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
export const clock = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export function parseRecord(input: unknown): RecordData {
  const record = recordSchema.parse(input);
  if (record.type === 'actual' && minutes(record.startTime) >= minutes(record.endTime))
    throw new Error('结束时间必须晚于开始时间');
  if (record.type === 'milestone' && record.dueTime && !record.dueDate)
    throw new Error('设置截止时刻前，请先选择截止日期');
  if (
    record.type === 'milestone' &&
    record.pool &&
    (record.dueDate || record.dueTime || record.completedAt)
  )
    throw new Error('待办池不设置截止时间或完成');
  return record;
}
export function validateChange(record: RecordData, entries: Entry[]) {
  const records = entries.filter((e) => e.data.id !== record.id).map((e) => e.data);
  const all = new Map(records.map((r) => [r.id, r]));
  if (isSpaceItem(record)) {
    const parent =
      record.type === 'workline'
        ? { id: record.projectId, type: 'project' }
        : record.type === 'milestone'
          ? { id: record.lineId, type: 'workline' }
          : record.type === 'todo'
            ? { id: record.milestoneId, type: 'milestone' }
            : null;
    if (parent && all.get(parent.id)?.type !== parent.type)
      throw new Error('所属项目、业务线或关键节点不存在，不能跨层级关联');
    if (record.resourceIds.some((id) => all.get(id)?.type !== 'resource'))
      throw new Error('资源不存在');
    if (record.type === 'workline') {
      if (!record.notesId) throw new Error('业务线缺少专属 Notes');
      const notes = all.get(record.notesId);
      if (notes?.type !== 'resource' || notes.location !== 'vault' || !/\.md$/i.test(notes.target))
        throw new Error('业务线 Notes 必须是工作目录内的 Markdown');
      if (records.some((r) => r.type === 'workline' && r.notesId === record.notesId))
        throw new Error('每条业务线使用自己的 Notes');
      if (
        records.filter((r) => r.type === 'milestone' && r.pool && r.lineId === record.id).length !==
        1
      )
        throw new Error('业务线必须有一个待办池');
    }
    if (
      record.type === 'milestone' &&
      record.pool &&
      records.some((r) => r.type === 'milestone' && r.pool && r.lineId === record.lineId)
    )
      throw new Error('每条业务线只能有一个待办池');
    if (
      record.type === 'todo' &&
      record.kind === 'idea' &&
      (record.direction !== 'self' || record.person)
    )
      throw new Error('IDEA 不设置交接联系人');
    if (record.type === 'todo' && record.direction !== 'self' && !record.person)
      throw new Error('To / From 待办需要填写联系人');
  }
  if (record.type === 'actual') {
    if (new Set(record.itemIds).size !== record.itemIds.length) throw new Error('关联条目不能重复');
    for (const itemId of record.itemIds)
      if (all.get(itemId)?.type !== 'todo') throw new Error('关联的 TODO 或 IDEA 不存在');
    if (
      records.some(
        (r) =>
          r.type === 'actual' &&
          r.date === record.date &&
          minutes(r.startTime) < minutes(record.endTime) &&
          minutes(r.endTime) > minutes(record.startTime),
      )
    )
      throw new Error('实际时间重叠，会重复计数；请先调整已有记录');
  }
  if (record.type === 'resource') {
    if (record.location === 'url' && !/^https?:\/\//i.test(record.target))
      throw new Error('仅支持 http(s) 链接');
    if (record.location === 'external' && !/^(?:[a-z]:[\\/]|\/)/i.test(record.target))
      throw new Error('外部资源需要绝对路径');
  }
}
export function timeTotals(entries: Entry[], from: string, to: string) {
  const all = new Map(entries.map((e) => [e.data.id, e.data]));
  const projects: Record<string, number> = {};
  let total = 0;
  const occupied = new Map<string, Set<number>>(),
    seenIds = new Set<string>();
  for (const { data: r } of [...entries].sort(
    (a, b) =>
      a.data.createdAt.localeCompare(b.data.createdAt) || a.data.id.localeCompare(b.data.id),
  )) {
    if (r.type !== 'actual' || r.date < from || r.date > to || seenIds.has(r.id)) continue;
    seenIds.add(r.id);
    const used = occupied.get(r.date) ?? new Set<number>();
    let duration = 0;
    for (let m = minutes(r.startTime); m < minutes(r.endTime); m++)
      if (!used.has(m)) {
        duration++;
        used.add(m);
      }
    occupied.set(r.date, used);
    const ids = new Set<string>();
    for (const todoId of r.itemIds) {
      const todo = all.get(todoId);
      const point = todo?.type === 'todo' ? all.get(todo.milestoneId) : null;
      const line = point?.type === 'milestone' ? all.get(point.lineId) : null;
      const project = line?.type === 'workline' ? all.get(line.projectId) : null;
      if (project?.type === 'project') ids.add(project.id);
    }
    const title =
      ids.size === 1
        ? (all.get([...ids][0]) as Project).title
        : ids.size > 1
          ? '跨项目（未分摊）'
          : '未关联';
    projects[title] = (projects[title] ?? 0) + duration;
    total += duration;
  }
  return { total, projects };
}
