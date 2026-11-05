import {
  type RecordData,
  type Entry,
  type Snapshot,
  type NoteContent,
  type DeletePreview,
  type DeleteResult,
  type SaveOptions,
} from '../../../packages/domain/index';
import { api, businessRequest } from './platform/http';
import type { BusinessCommand } from '../../../packages/domain/business';
export { createRecord } from '../../../packages/domain/index';
export { api, session } from './platform/http';

export async function command<T>(input: BusinessCommand): Promise<T> {
  return (await businessRequest<{ result: T }>('commands', input)).result;
}
export const load = async () =>
  (await businessRequest<{ snapshot: Snapshot }>('workspace')).snapshot;
export const deletePreview = (id: string) =>
  command<DeletePreview>({ type: 'work.deletePreview', id });
export const deleteSpace = (id: string, entries: Entry[]) =>
  command<DeleteResult>({
    type: 'work.delete',
    id,
    expectations: Object.fromEntries(entries.map((e) => [e.data.id, e.revision])),
  });
export const complete = (entry: Entry, completed: boolean) =>
  command<Entry>({ type: 'work.complete', id: entry.data.id, revision: entry.revision, completed });
export const save = (data: RecordData, entry?: Entry, options?: SaveOptions) =>
  command<Entry>({ type: 'record.save', data, revision: entry?.revision, options });
export const deleteActual = (entry: Entry) =>
  command<DeleteResult>({ type: 'actual.delete', id: entry.data.id, revision: entry.revision });
export async function removeSpace(entry: Entry) {
  const id = entry.data.id;
  const preview = await deletePreview(id);
  if (preview.blockedReason) throw new Error(preview.blockedReason);
  if (preview.entries.find((e) => e.data.id === id)?.revision !== entry.revision)
    throw new Error('文件已更改，请重新加载；未删除更改后的待办');
  return deleteSpace(id, preview.entries);
}
export const promote = (entry: Entry) =>
  command<Entry>({ type: 'work.promote', id: entry.data.id, revision: entry.revision });
export async function openResource(id: string, native = true) {
  const result = await api<{ url?: string }>('open', { id, native });
  if (result.url?.startsWith('obsidian://')) window.location.href = result.url;
  else if (result.url) window.open(result.url, '_blank', 'noopener,noreferrer');
}
export const readContent = (id: string) => command<NoteContent>({ type: 'notes.read', id });
export const saveContent = (
  id: string,
  body: string,
  revision: string,
  comments?: { id: string; text: string }[],
) => command<NoteContent>({ type: 'notes.save', id, body, revision, comments });
export const appendContent = (id: string, text: string, revision: string) =>
  command({ type: 'notes.append', id, text, revision });
