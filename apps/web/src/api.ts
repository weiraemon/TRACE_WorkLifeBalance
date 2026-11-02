import {
  parseRecord,
  type RecordData,
  type Entry,
  type Snapshot,
  type NoteContent,
  type DeletePreview,
  type DeleteResult,
  type SaveOptions,
} from '../../../packages/domain/index';
import { api } from './platform/http';
export { api, session } from './platform/http';

export const load = () => api<Snapshot>('snapshot');
export const deletePreview = (id: string) => api<DeletePreview>('delete-preview', { id });
export const deleteSpace = (id: string, entries: Entry[]) =>
  api<DeleteResult>('delete-space', {
    id,
    expectations: Object.fromEntries(entries.map((e) => [e.data.id, e.revision])),
  });
export const save = (data: RecordData, entry?: Entry, options?: SaveOptions) =>
  api<Entry>('records', { data, revision: entry?.revision, options });
export async function removeSpace(entry: Entry) {
  const id = entry.data.id;
  const preview = await deletePreview(id);
  if (preview.blockedReason) throw new Error(preview.blockedReason);
  if (preview.entries.find((e) => e.data.id === id)?.revision !== entry.revision)
    throw new Error('文件已更改，请重新加载；未删除更改后的待办');
  return deleteSpace(id, preview.entries);
}
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
