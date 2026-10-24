import { useState } from 'react';
import { noteKinds, noteKindLabel, type Snapshot } from '../../../../packages/domain/index';
import { api, save, createRecord } from '../api';
import { Modal, Field, Button, ErrorMessage, DatePicker } from '../components/ui';
import type { Editor } from './editor';
export function ReferenceForm({
  editor,
  close,
  reload,
  snapshot,
}: {
  editor: Editor;
  close: () => void;
  reload: () => Promise<void>;
  snapshot: Snapshot;
}) {
  const old = editor.entry?.data;
  const [value, setValue] = useState<Record<string, string>>(() =>
    old?.type === 'resource'
      ? { title: old.title, target: old.target, location: old.location, kind: old.kind }
      : old?.type === 'review'
        ? {
            week: old.week,
            mainline: old.mainline,
            outcomes: old.outcomes,
            reflection: old.reflection,
            nextWeek: old.nextWeek,
          }
        : ({ ...editor.defaults } as Record<string, string>),
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const set = (key: string, v: string) => setValue((s) => ({ ...s, [key]: v }));
  const resource = editor.type === 'resource';
  const markdown = resource && !old && editor.defaults?.createMarkdown === true;
  const ownedMarkdown = old?.type === 'resource' && old.noteId === old.id;
  const tags = [
    ...new Set(
      snapshot.entries.flatMap(({ data }) =>
        data.type === 'resource' && data.tag ? [data.tag] : [],
      ),
    ),
  ].sort();
  const input = (key: string, label: string) => (
    <Field key={key} label={label}>
      <textarea rows={3} value={value[key] ?? ''} onChange={(e) => set(key, e.target.value)} />
    </Field>
  );
  return (
    <Modal title={markdown ? '新建笔记' : resource ? '关联资源' : '每周回顾'} onClose={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            if (markdown) {
              await api('notes', {
                title: value.title,
                kind: value.kind ?? 'note',
                tag: value.tag ?? '',
              });
            } else
              await save(
                createRecord(editor.type, {
                  ...(old ?? {}),
                  ...value,
                  ...(resource
                    ? {
                        location:
                          value.location ?? (/^https?:\/\//i.test(value.target) ? 'url' : 'vault'),
                      }
                    : {}),
                }),
                editor.entry,
              );
            await reload();
            close();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {markdown ? (
          <>
            <Field label="标题">
              <input
                required
                autoFocus
                value={value.title ?? ''}
                onChange={(e) => set('title', e.target.value)}
              />
            </Field>
            <details className="optional-settings">
              <summary>可选设置</summary>
              <Field label="笔记类型">
                <select value={value.kind ?? 'note'} onChange={(e) => set('kind', e.target.value)}>
                  {noteKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {noteKindLabel[kind]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="标签">
                <input
                  list="note-tags"
                  maxLength={60}
                  value={value.tag ?? ''}
                  onChange={(e) => set('tag', e.target.value)}
                />
                <datalist id="note-tags">
                  {tags.map((tag) => (
                    <option key={tag} value={tag} />
                  ))}
                </datalist>
              </Field>
            </details>
          </>
        ) : resource ? (
          <>
            <Field label="资源名称">
              <input
                required
                autoFocus
                value={value.title ?? ''}
                onChange={(e) => set('title', e.target.value)}
              />
            </Field>
            {!ownedMarkdown && (
              <Field label="路径 / URL">
                <input
                  required
                  value={value.target ?? ''}
                  onChange={(e) => set('target', e.target.value)}
                />
              </Field>
            )}
            <details className="optional-settings">
              <summary>可选设置</summary>
              <Field label="笔记类型">
                <select value={value.kind ?? 'note'} onChange={(e) => set('kind', e.target.value)}>
                  {noteKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {noteKindLabel[kind]}
                    </option>
                  ))}
                </select>
              </Field>
              {!ownedMarkdown && (
                <Field label="资源位置">
                  <select
                    value={
                      value.location ?? (/^https?:\/\//i.test(value.target ?? '') ? 'url' : 'vault')
                    }
                    onChange={(e) => set('location', e.target.value)}
                  >
                    <option value="vault">Vault 文件或文件夹</option>
                    <option value="url">网页链接</option>
                    <option value="external">外部文件或文件夹（只打开）</option>
                  </select>
                </Field>
              )}
            </details>
          </>
        ) : (
          <>
            <Field label="本周">
              <DatePicker value={value.week ?? ''} onChange={(e) => set('week', e.target.value)} />
            </Field>
            {input('outcomes', '本周进展')}
            <details className="optional-settings">
              <summary>再多写一点（可选）</summary>
              {input('mainline', '本周主线')}
              {input('reflection', '体会与问题')}
              {input('nextWeek', '下周继续什么')}
            </details>
          </>
        )}
        <ErrorMessage message={error} />
        <div className="form-actions">
          <Button type="button" onClick={close}>
            取消
          </Button>
          <Button className="primary" type="submit" disabled={busy}>
            {busy ? '正在保存…' : '保存到 Vault'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function ResourcePicker({
  values,
  snapshot,
  onChange,
}: {
  values: string[];
  snapshot: Snapshot;
  onChange: (ids: string[]) => void;
}) {
  const resources = snapshot.entries.filter((e) => e.data.type === 'resource');
  return (
    <fieldset className="resource-picker">
      <legend>关联资源（可选）</legend>
      {resources.map(
        (e) =>
          e.data.type === 'resource' && (
            <label key={e.data.id}>
              <input
                type="checkbox"
                checked={values.includes(e.data.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...values, e.data.id]
                      : values.filter((id) => id !== e.data.id),
                  )
                }
              />
              {e.data.title}
            </label>
          ),
      )}
    </fieldset>
  );
}
