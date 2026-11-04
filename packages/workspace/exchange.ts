import {
  exchangeFormat,
  exchangeHash,
  exchangeRecord,
  parseExchange,
  sealExchange,
  type ExchangeBundle,
  type ExchangeDocument,
  type ExchangeItem,
  type ExchangePreview,
  type ExchangeReceipt,
} from '../domain/exchange';
import { validateChange, type Entry, type RecordData, type Snapshot } from '../domain/index';
import { canPromote } from '../domain/workspace';
import type { Workspace } from './workspace';
import { VaultError } from './errors';

const itemHash = (item: ExchangeItem) =>
  exchangeHash({ data: exchangeRecord(item.data), body: item.body });
const title = (data: RecordData) =>
  'title' in data ? data.title : data.type === 'actual' ? data.description : data.week;
const normalize = (text: string) => text.normalize('NFKC').trim().toLowerCase();
function localRecord(data: RecordData, entries: Entry[]): RecordData {
  if (data.type !== 'resource' || data.noteId !== data.id) return data;
  const current = entries.find((entry) => entry.data.id === data.id)?.data;
  return {
    ...data,
    target:
      current?.type === 'resource' && current.noteId === current.id
        ? current.target
        : `ATLAS/knowledge/imported/${data.id}.md`,
  };
}
async function checkedBundle(input: unknown) {
  const bundle = await parseExchange(input);
  if (bundle.kind !== 'bundle') throw new VaultError('这是回执，请用于发送时的共同版本');
  for (const change of bundle.changes)
    if ((await itemHash(change)) !== change.hash) throw new VaultError('对象内容校验失败，未导入');
  return bundle;
}
async function plan(
  bundle: ExchangeBundle,
  snapshot: Snapshot,
  items: ExchangeItem[],
  vault: Workspace,
) {
  const current = new Map<string, { item: ExchangeItem; hash: string }>();
  for (const [index, item] of items.entries()) {
    await vault.progress('正在比对本机内容版本', index, items.length);
    current.set(item.data.id, { item, hash: await itemHash(item) });
  }
  const rows: ExchangePreview['rows'] = [];
  const records: RecordData[] = [],
    bodies = new Map<string, string>();
  const errors: string[] = [];
  for (const change of bundle.changes) {
    const id = change.data.id,
      existing = current.get(id);
    let status: ExchangePreview['rows'][number]['status'] = 'conflict';
    let reason = '双方内容都已修改，保留本机内容；请先人工整理后重新交换';
    if (existing?.hash === change.hash) {
      status = 'same';
      reason = 'UUID 与内容一致，跳过重复导入';
    } else if (!existing && change.baseHash === null) {
      status = 'create';
      reason = '新 UUID';
    } else if (existing?.hash === change.baseHash) {
      status = 'update';
      reason = '本机仍是共同版本';
    } else if (!existing) reason = '本机已删除或缺失这个旧对象，禁止自动复活';
    if (
      existing &&
      existing.item.data.type !== change.data.type &&
      !(change.data.type === 'workline' && canPromote(existing.item.data))
    ) {
      status = 'conflict';
      reason = '同一 UUID 的类型不一致';
    }
    const data = localRecord(change.data, snapshot.entries);
    const old = existing?.item.data;
    if (
      old &&
      ((old.type === 'workline' && data.type === 'workline' && old.notesId !== data.notesId) ||
        (old.type === 'milestone' &&
          data.type === 'milestone' &&
          (old.pool !== data.pool || (old.pool && old.lineId !== data.lineId))) ||
        (old.type === 'resource' &&
          data.type === 'resource' &&
          (old.noteId === old.id) !== (data.noteId === data.id)))
    ) {
      status = 'conflict';
      reason = '不能替换既有业务线 Notes 或待办池身份';
    }
    const candidates = existing
      ? []
      : snapshot.entries
          .filter(
            (entry) =>
              entry.data.type === data.type &&
              normalize(title(entry.data)) === normalize(title(data)),
          )
          .map((entry) => entry.data.id);
    if (candidates.length && status === 'create') reason += '；同名对象 UUID 不同，不自动合并';
    rows.push({ id, title: title(data), status, reason, candidates });
    if (status === 'create' || status === 'update') {
      records.push(data);
      bodies.set(id, change.body);
    }
  }
  const changed = new Set(records.map((data) => data.id));
  const virtual = [
    ...snapshot.entries.filter((entry) => !changed.has(entry.data.id)),
    ...records.map((data) => ({ data, path: '', revision: '' })),
  ];
  for (const [index, record] of virtual.entries()) {
    if (index % 20 === 0) await vault.progress('正在检查导入关联与冲突', index, virtual.length);
    try {
      validateChange(record.data, virtual);
    } catch (error) {
      errors.push(
        `${title(record.data)}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // A delta requires its unchanged context. Never silently import half a workline.
  for (const id of Object.keys(bundle.manifest))
    if (!virtual.some((entry) => entry.data.id === id))
      errors.push(`缺少共同对象 ${id}，请先完成首次全量交换`);
  const revision = await exchangeHash({
    session: snapshot.vaultId,
    bundle: bundle.checksum,
    entries: snapshot.entries.map((entry) => [entry.data.id, entry.revision]).sort(),
  });
  const receiptHashes = { ...bundle.baseline };
  for (const [id, hash] of Object.entries(bundle.manifest))
    if (
      current.get(id)?.hash === hash ||
      rows.some((row) => row.id === id && ['create', 'update'].includes(row.status))
    )
      receiptHashes[id] = hash;
  return {
    preview: { rows, errors: [...new Set(errors)], revision, missingIds: bundle.missingIds },
    records,
    bodies,
    receiptHashes,
  };
}

export async function exportExchange(
  vault: Workspace,
  baseline?: unknown,
): Promise<ExchangeBundle> {
  let receipt: ExchangeReceipt | undefined;
  if (baseline !== undefined && baseline !== null) {
    const document = await parseExchange(baseline);
    if (document.kind !== 'receipt') throw new VaultError('共同版本必须是对方确认后生成的回执');
    receipt = document;
  }
  const { items } = await vault.readManaged();
  const manifest: Record<string, string> = {},
    changes: ExchangeBundle['changes'] = [];
  if (items.length > 1000) throw new VaultError('首版最多交换 1000 个受管对象，请改用完整目录转移');
  for (const item of items) {
    const hash = await itemHash(item),
      id = item.data.id;
    manifest[id] = hash;
    if (receipt?.hashes[id] !== hash)
      changes.push({
        operationId: crypto.randomUUID(),
        data: exchangeRecord(item.data),
        body: item.body,
        baseHash: receipt?.hashes[id] ?? null,
        hash,
      });
  }
  const bundle = await sealExchange({
    format: exchangeFormat,
    version: 1 as const,
    kind: 'bundle' as const,
    id: crypto.randomUUID(),
    channelId: receipt?.channelId ?? crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    baseline: receipt?.hashes ?? {},
    manifest,
    changes,
    missingIds: Object.keys(receipt?.hashes ?? {}).filter((id) => !manifest[id]),
  });
  await parseExchange(bundle);
  return bundle;
}
export async function previewExchange(vault: Workspace, input: unknown): Promise<ExchangePreview> {
  const bundle = await checkedBundle(input);
  const { snapshot, items } = await vault.readManaged();
  return (await plan(bundle, snapshot, items, vault)).preview;
}
export async function applyExchange(vault: Workspace, input: unknown, revision: string) {
  const bundle = await checkedBundle(input);
  return vault.applyBatch(async (tx) => {
    const items = [];
    for (const [index, entry] of tx.snapshot.entries.entries()) {
      await vault.progress('正在复核导入前的文件版本', index, tx.snapshot.entries.length);
      items.push({ data: entry.data, body: await tx.readBody(entry) });
    }
    const result = await plan(bundle, tx.snapshot, items, vault);
    if (result.preview.revision !== revision)
      throw new VaultError('预览后本机内容已更改，请重新预览', 409);
    if (
      result.preview.errors.length ||
      result.preview.rows.some((row) => row.status === 'conflict')
    )
      throw new VaultError('存在冲突或缺失关联，整包未导入，请先处理并重新交换', 409);
    const receipt: ExchangeDocument = await sealExchange({
      format: exchangeFormat,
      version: 1 as const,
      kind: 'receipt' as const,
      id: crypto.randomUUID(),
      channelId: bundle.channelId,
      createdAt: new Date().toISOString(),
      packageId: bundle.id,
      hashes: result.receiptHashes,
    });
    return {
      records: result.records,
      bodies: result.bodies,
      result: {
        receipt,
        imported: result.records.length,
        skipped: result.preview.rows.filter((row) => row.status === 'same').length,
      },
    };
  });
}
