import { z } from 'zod';
import { day, saveOptionsSchema } from './index';
export const businessApiVersion = '1' as const;
export const planDestinationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('existing'),
      lineId: z.string().uuid(),
      reason: z.string().max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('newLine'),
      projectId: z.string().uuid(),
      lineTitle: z.string().trim().min(1).max(300),
      reason: z.string().max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('newProject'),
      projectTitle: z.string().trim().min(1).max(300),
      lineTitle: z.string().trim().min(1).max(300),
      reason: z.string().max(1000),
    })
    .strict(),
]);
export type PlanDestination = z.infer<typeof planDestinationSchema>;
export type BusinessCatalog = {
  id: string;
  title: string;
  lines: { id: string; title: string }[];
}[];

export function resolvePlanDestination(
  title: string,
  context: string,
  catalog: BusinessCatalog,
  projectId: string | null = null,
): PlanDestination {
  const clean = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
  const text = normalize(`${title}\n${context}`);
  const lineTitle = clean(title).slice(0, 300) || '待整理';
  const scoped = projectId ? catalog.find((item) => item.id === projectId) : undefined;
  const project = scoped ?? catalog.find((item) => text.includes(normalize(item.title)));
  if (project) {
    const line = project.lines.find((item) => text.includes(normalize(item.title)));
    if (line) return { kind: 'existing', lineId: line.id, reason: '按消息内容匹配现有业务线' };
    return {
      kind: 'newLine',
      projectId: project.id,
      lineTitle,
      reason: scoped
        ? `按消息内容在限定项目「${project.title}」下新建业务线`
        : `按消息内容在「${project.title}」下新建业务线`,
    };
  }
  return {
    kind: 'newProject',
    projectTitle: lineTitle.slice(0, 60),
    lineTitle,
    reason: '按消息内容新建项目与业务线',
  };
}

export const planSchema = z
  .object({
    kind: z.enum(['task', 'event']),
    title: z.string().trim().min(1).max(300),
    dueDate: day.nullable().default(null),
    dueTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .default(null),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    location: z.string().trim().max(300).nullable().default(null),
    actions: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
    destination: planDestinationSchema.nullable().default(null),
    lineId: z.union([z.string().uuid(), z.literal('')]).default(''),
    projectId: z.string().uuid().nullable().default(null),
    context: z.string().max(18000).default(''),
    note: z
      .object({ id: z.string().uuid(), text: z.string().min(1).max(30000), date: day })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => !value.dueTime || Boolean(value.dueDate), '有时刻时必须有日期');
export type CreatePlan = z.infer<typeof planSchema>;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const target = { id: z.string().uuid(), revision };
export const businessCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('record.save'),
      data: z.unknown(),
      revision: revision.optional(),
      options: saveOptionsSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal('work.complete'), ...target, completed: z.boolean() }).strict(),
  z
    .object({
      type: z.literal('work.reschedule'),
      ...target,
      dueDate: day.nullable(),
      dueTime: z
        .string()
        .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
        .nullable()
        .optional(),
      location: z.string().max(300).nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('work.comment'),
      ...target,
      text: z.string().trim().min(1).max(30000),
      date: day.optional(),
    })
    .strict(),
  z.object({ type: z.literal('plan.create'), plan: planSchema }).strict(),
  z.object({ type: z.literal('work.promote'), ...target }).strict(),
  z.object({ type: z.literal('work.deletePreview'), id: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal('work.delete'),
      id: z.string().uuid(),
      expectations: z.record(z.string().uuid(), revision),
    })
    .strict(),
  z.object({ type: z.literal('notes.read'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('notes.save'), ...target, body: z.string().max(500000) }).strict(),
]);
export type BusinessCommand = z.infer<typeof businessCommandSchema>;
