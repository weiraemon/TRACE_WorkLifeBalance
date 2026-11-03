import { z } from 'zod';
import { parseRecord, recordSchema, type RecordData } from './index';

export const exchangeFormat = 'chaos.exchange' as const;
export const exchangeMaxBytes = 512 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const hashes = z
  .record(z.string().uuid(), hash)
  .refine((value) => Object.keys(value).length <= 1000);
const header = {
  format: z.literal(exchangeFormat),
  version: z.literal(1),
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  createdAt: z.iso.datetime(),
};
export const exchangeReceiptSchema = z
  .object({
    ...header,
    kind: z.literal('receipt'),
    packageId: z.string().uuid(),
    hashes,
    checksum: hash,
  })
  .strict();
export const exchangeBundleSchema = z
  .object({
    ...header,
    kind: z.literal('bundle'),
    baseline: hashes,
    manifest: hashes,
    changes: z
      .array(
        z
          .object({
            operationId: z.string().uuid(),
            data: recordSchema,
            body: z.string().max(500000),
            baseHash: hash.nullable(),
            hash,
          })
          .strict(),
      )
      .max(1000),
    missingIds: z.array(z.string().uuid()).max(1000),
    checksum: hash,
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>(),
      operations = new Set<string>();
    for (const change of value.changes) {
      if (ids.has(change.data.id) || operations.has(change.operationId))
        context.addIssue({ code: 'custom', message: '交换包含重复对象或操作 ID' });
      ids.add(change.data.id);
      operations.add(change.operationId);
      try {
        parseRecord(change.data);
      } catch {
        context.addIssue({ code: 'custom', message: '交换记录不符合领域规则' });
      }
      if (
        value.manifest[change.data.id] !== change.hash ||
        (value.baseline[change.data.id] ?? null) !== change.baseHash
      )
        context.addIssue({ code: 'custom', message: '交换变更与清单或共同版本不一致' });
      if (
        change.data.type === 'resource' &&
        change.data.noteId === change.data.id &&
        change.data.target !== `chaos-note:${change.data.id}`
      )
        context.addIssue({ code: 'custom', message: '笔记只传输逻辑标识，不接受文件路径' });
    }
    for (const [id, version] of Object.entries(value.manifest))
      if (!ids.has(id) && value.baseline[id] !== version)
        context.addIssue({ code: 'custom', message: '清单中的新增或更新缺少正文' });
    const missing = Object.keys(value.baseline)
      .filter((id) => !value.manifest[id])
      .sort();
    if (JSON.stringify(missing) !== JSON.stringify([...value.missingIds].sort()))
      context.addIssue({ code: 'custom', message: '缺失对象清单不一致' });
  });
export type ExchangeBundle = z.infer<typeof exchangeBundleSchema>;
export type ExchangeReceipt = z.infer<typeof exchangeReceiptSchema>;
export type ExchangeDocument = ExchangeBundle | ExchangeReceipt;
export type ExchangeItem = { data: RecordData; body: string };
export type ExchangePreview = {
  revision: string;
  rows: {
    id: string;
    title: string;
    status: 'create' | 'update' | 'same' | 'conflict';
    reason: string;
    candidates: string[];
  }[];
  errors: string[];
  missingIds: string[];
};

// Storage paths for managed notes are local; their UUID is the transferable identity.
export function exchangeRecord(data: RecordData): RecordData {
  return data.type === 'resource' && data.noteId === data.id
    ? { ...data, target: `chaos-note:${data.id}` }
    : data;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export async function exchangeHash(value: unknown): Promise<string> {
  const result = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(result), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}
export async function sealExchange<T extends object>(value: T): Promise<T & { checksum: string }> {
  return { ...value, checksum: await exchangeHash(value) };
}
export async function parseExchange(input: unknown): Promise<ExchangeDocument> {
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > exchangeMaxBytes)
    throw new Error('交换文件超过 512 KiB，请改用完整目录转移；首版不支持分片');
  const document = z.union([exchangeBundleSchema, exchangeReceiptSchema]).parse(input);
  const { checksum, ...payload } = document;
  if ((await exchangeHash(payload)) !== checksum) throw new Error('交换文件校验失败，未导入');
  return document;
}
