import { z } from 'zod';
import { day } from './index';
import { planDestinationSchema as destinationSchema } from './business';

const terms = z.array(z.string().trim().min(1).max(100)).max(30);
export const aiProviders = ['deepseek', 'openai', 'custom'] as const;
export type AiProvider = (typeof aiProviders)[number];
export const aiProviderSchema = z.enum(aiProviders);
export type AiProviderDefault = {
  label: string;
  baseUrl: string;
  model: string;
  env: string;
};
export const aiDefaults: Record<AiProvider, AiProviderDefault> = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    env: 'DEEPSEEK_API_KEY',
  },
  openai: {
    label: 'OpenAI / ChatGPT',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    env: 'OPENAI_API_KEY',
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    model: '',
    env: 'CHAOS_AI_API_KEY',
  },
};
export type AiProfileSettings = { baseUrl: string; model: string; jsonMode: boolean };
export type AiSettings = AiProfileSettings & { provider: AiProvider };
export const conditionLabels = {
  atAll: '@全体成员',
  atMe: '@自己',
  name: '本人姓名或别名',
  class: '班级名称或简称',
  sender: '指定发送人',
  keyword: '关键词',
} as const;
export const messageRuleSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(['group', 'private']),
    enabled: z.boolean(),
    useAi: z.boolean().default(true),
    autoAccept: z.boolean().default(false),
    includeSelf: z.boolean().default(false),
    mode: z.enum(['all', 'conditions']),
    conditions: z.array(z.enum(['atAll', 'atMe', 'name', 'class', 'sender', 'keyword'])).max(6),
    senders: terms,
    keywords: terms,
    aliases: terms,
    chatId: z.string().trim().max(100).nullable().default(null),
    projectId: z.string().uuid().nullable().default(null),
    lineId: z.string().uuid().nullable(),
  })
  .strict()
  .refine((r) => r.mode === 'all' || r.conditions.length > 0, '请至少选择一个筛选条件');
export const messageSettingsSchema = z
  .object({
    names: terms,
    classes: terms,
    rules: z.array(messageRuleSchema).max(50),
  })
  .strict()
  .refine((s) => new Set(s.rules.map((r) => r.id)).size === s.rules.length, '会话规则 ID 重复');
export const sourceMessageSchema = z
  .object({
    ruleId: z.string().uuid(),
    sender: z.string().trim().min(1).max(100),
    sentAt: z.iso.datetime({ offset: true }),
    text: z.string().trim().min(1).max(12000),
    atAll: z.boolean(),
    atMe: z.boolean(),
    context: z.string().max(6000).default(''),
    remoteId: z.string().trim().max(120).nullable().default(null),
    fromSelf: z.boolean().default(false),
  })
  .strict();
export {
  planDestinationSchema as destinationSchema,
  resolvePlanDestination as fallbackDestination,
} from './business';
export type {
  PlanDestination as MessageDestination,
  BusinessCatalog as MessageCatalog,
} from './business';
export const suggestionSchema = z
  .object({
    kind: z.enum(['task', 'event', 'change', 'cancel', 'ignore']),
    targetId: z.string().uuid().nullable().default(null),
    title: z.string().trim().min(1).max(300),
    dueDate: day.nullable(),
    dueTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .nullable(),
    reason: z.string().min(1).max(1500),
    uncertainty: z.string().max(1500),
    actions: z.array(z.string().trim().min(1).max(300)).max(10),
    completed: z.boolean().default(false),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    location: z.string().trim().max(300).nullable().default(null),
    destination: destinationSchema.nullable().optional(),
  })
  .strict()
  .refine((s) => !s.dueTime || !!s.dueDate, '有时刻时必须有日期');
export const candidateSchema = z
  .object({
    id: z.string().uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    raw: z.boolean().default(false),
    conversation: z.string().max(100),
    source: sourceMessageSchema,
    suggestion: suggestionSchema,
    projectId: z.string().uuid().nullable().default(null),
    lineId: z.string().uuid().nullable(),
    receivedAt: z.iso.datetime(),
  })
  .strict();
export const inboxSchema = z
  .object({
    version: z.literal(1),
    settings: messageSettingsSchema,
    candidates: z.array(candidateSchema).max(100),
    seen: z
      .array(
        z
          .object({
            fingerprint: z.string(),
            at: z.iso.datetime(),
            messageId: z.string().max(120).optional(),
          })
          .strict(),
      )
      .max(500),
    sync: z
      .array(
        z
          .object({
            chatId: z.string().max(100),
            afterRowid: z.string().max(40),
            afterTime: z.number(),
            afterId: z.string().max(40),
          })
          .strict(),
      )
      .max(200)
      .default([]),
  })
  .strict();
export type MessageSettings = z.infer<typeof messageSettingsSchema>;
export type MessageRule = z.infer<typeof messageRuleSchema>;
export type SourceMessage = z.infer<typeof sourceMessageSchema>;
export type Suggestion = z.infer<typeof suggestionSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type Inbox = z.infer<typeof inboxSchema>;
export type AiProfileView = AiProfileSettings & {
  keyConfigured: boolean;
  keySaved: boolean;
  keyFromEnv: boolean;
  ready: boolean;
};
export type AiView = {
  provider: AiProvider;
  location: string;
  profiles: Record<AiProvider, AiProfileView>;
};
export type QqStatus = {
  enabled: boolean;
  dataDir: string;
  python: string;
  intervalSeconds: number;
  backfillDays: number;
  selfQQ: string;
  keySaved: boolean;
  configured: boolean;
  location: string;
  running: boolean;
  lastSyncAt: string | null;
  lastError: string;
};
export type InboxView = { state: Inbox; revision: string | null; ai: AiView; qq: QqStatus };
export const emptyInbox = (): Inbox => ({
  version: 1,
  settings: { names: [], classes: [], rules: [] },
  candidates: [],
  seen: [],
  sync: [],
});

export function matchMessage(settings: MessageSettings, message: SourceMessage) {
  const rule = settings.rules.find((r) => r.id === message.ruleId);
  if (!rule?.enabled) return false;
  if (rule.includeSelf && message.fromSelf) return true;
  if (rule.mode === 'all') return true;
  const contains = (values: string[]) =>
    values.some((v) =>
      message.text.normalize('NFKC').toLowerCase().includes(v.normalize('NFKC').toLowerCase()),
    );
  return rule.conditions.some(
    (c) =>
      ({
        atAll: message.atAll,
        atMe: message.atMe,
        name: contains([...settings.names, ...rule.aliases]),
        class: contains(settings.classes),
        sender: rule.senders.includes(message.sender),
        keyword: contains(rule.keywords),
      })[c],
  );
}
