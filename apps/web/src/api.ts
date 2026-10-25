import {
  parseRecord,
  recordContract,
  type RecordData,
  type Entry,
  type Snapshot,
  type NoteContent,
  type DeletePreview,
  type DeleteResult,
  type SaveOptions,
} from '../../../packages/domain/index';
let token = '';
let vaultId = '';
export async function api<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'X-Atlas-Token': token,
      'X-Atlas-Vault': vaultId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.headers.get('X-Atlas-Contract') !== recordContract)
    throw new Error(
      '前端与本地服务的数据模型不一致。请在原终端按 Ctrl+C 停止旧服务，然后在当前项目目录执行 npm run build 和 npm start，刷新页面后重试。未保存的输入请先复制保留。',
    );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '请求失败');
  if (route === 'connect') vaultId = value.vaultId;
  return value;
}
export async function session() {
  const value = await api<{ token: string; connected: boolean; root: string; vaultId: string }>(
    'session',
  );
  token = value.token;
  vaultId = value.vaultId;
  return value;
}
export const load = () => api<Snapshot>('snapshot');
export const deletePreview = (id: string) => api<DeletePreview>('delete-preview', { id });
export const deleteSpace = (id: string, entries: Entry[]) =>
  api<DeleteResult>('delete-space', {
    id,
    expectations: Object.fromEntries(entries.map((e) => [e.data.id, e.revision])),
  });
export const save = (data: RecordData, entry?: Entry, options?: SaveOptions) =>
  api<Entry>('records', { data, revision: entry?.revision, options });
export const promote = (entry: Entry) =>
  api<Entry>('promote', { id: entry.data.id, revision: entry.revision });
export function createRecord(type: RecordData['type'], fields: object): RecordData {
  const now = new Date().toISOString();
  return parseRecord({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    type,
    ...fields,
  });
}
export async function openResource(id: string, native = true) {
  const result = await api<{ url?: string }>('open', { id, native });
  if (result.url?.startsWith('obsidian://')) window.location.href = result.url;
  else if (result.url) window.open(result.url, '_blank', 'noopener,noreferrer');
}
export const readContent = (id: string) => api<NoteContent>('content', { action: 'read', id });
export const saveContent = (id: string, body: string, revision: string) =>
  api<NoteContent>('content', { action: 'save', id, body, revision });
export async function openObsidian(id: string) {
  const result = await api<{ url: string }>('obsidian', { id });
  window.location.href = result.url;
}
