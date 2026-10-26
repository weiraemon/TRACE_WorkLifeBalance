import { useState } from 'react';
import {
  directionLabel,
  milestoneTags,
  isSpaceItem,
  type Snapshot,
} from '../../../../packages/domain/index';
import { Button, Field, DatePicker, Modal, ErrorMessage } from '../components/ui';
import { createRecord, save } from '../api';
import { ImportancePicker } from '../components/Importance';
import type { Editor } from './editor';
import { WorkLocationPicker, initialLocation } from './WorkLocationPicker';
export const spaceLabel = { project: '项目', workline: '业务线', milestone: '节点', todo: '条目' };
export function WorkItemForm({
  editor,
  snapshot,
  close,
  reload,
}: {
  editor: Editor;
  snapshot: Snapshot;
  close: () => void;
  reload: () => Promise<void>;
}) {
  const type = editor.type as keyof typeof spaceLabel;
  const item = editor.entry && isSpaceItem(editor.entry.data) ? editor.entry.data : undefined;
  const defaults = editor.defaults ?? {};
  const [title, setTitle] = useState(item?.title ?? String(defaults.title ?? ''));
  const [kind, setKind] = useState<'todo' | 'idea'>(
    item?.type === 'todo' ? item.kind : defaults.kind === 'idea' ? 'idea' : 'todo',
  );
  const [location, setLocation] = useState(() => initialLocation(snapshot.entries, item, defaults));
  const [importance, setImportance] = useState(item?.importance ?? 1);
  const [dueDate, setDueDate] = useState(
    item?.type === 'milestone' || item?.type === 'todo' ? (item.dueDate ?? '') : '',
  );
  const [dueTime, setDueTime] = useState(item?.type === 'milestone' ? (item.dueTime ?? '') : '');
  const [tags, setTags] = useState(item?.type === 'milestone' ? item.tags.join('，') : '');
  const [direction, setDirection] = useState(item?.type === 'todo' ? item.direction : 'self');
  const [person, setPerson] = useState(item?.type === 'todo' ? item.person : '');
  const [comment, setComment] = useState('');
  const [commentId] = useState(() => crypto.randomUUID());
  const [recordId] = useState(() => item?.id ?? crypto.randomUUID());
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const pool = item?.type === 'milestone' && item.pool;
  const knownTags = [
    ...new Set([
      ...milestoneTags,
      ...snapshot.entries.flatMap((e) => (e.data.type === 'milestone' ? e.data.tags : [])),
    ]),
  ];
  return (
    <Modal
      title={`${item ? '编辑' : '新增'}${type === 'todo' ? kind.toUpperCase() : spaceLabel[type]}`}
      onClose={close}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            const data = createRecord(type, {
              ...(item ?? {}),
              id: recordId,
              title,
              importance,
              ...(type === 'workline' ? { projectId: location.projectId } : {}),
              ...(type === 'milestone'
                ? {
                    lineId: location.lineId,
                    dueDate: pool ? null : dueDate || null,
                    dueTime: pool ? null : dueTime || null,
                    tags: [
                      ...new Set(
                        tags
                          .split(/[,，]/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                      ),
                    ],
                  }
                : {}),
              ...(type === 'todo'
                ? {
                    milestoneId: location.milestoneId,
                    kind,
                    dueDate: dueDate || null,
                    direction: kind === 'idea' ? 'self' : direction,
                    person: kind === 'idea' || direction === 'self' ? '' : person,
                  }
                : {}),
            });
            await save(data, editor.entry, {
              comments: comment.trim()
                ? [{ id: commentId, targetId: recordId, text: comment }]
                : [],
            });
            await reload();
            close();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="标题">
          <input required autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        {type === 'todo' && (
          <Field label="内容类型">
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="todo">TODO</option>
              <option value="idea">IDEA</option>
            </select>
          </Field>
        )}
        {type !== 'project' && (
          <WorkLocationPicker
            entries={snapshot.entries}
            level={type}
            value={location}
            onChange={setLocation}
          />
        )}
        <fieldset className="primary-settings">
          <legend>重要性</legend>
          <ImportancePicker value={importance} onChange={setImportance} />
        </fieldset>
        {type === 'milestone' && !pool && (
          <Field label="节点标签">
            <input
              list="node-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="会议，报告，专注…"
            />
            <datalist id="node-tags">
              {knownTags.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
          </Field>
        )}
        <details className="optional-settings">
          <summary>可选设置</summary>
          {(type === 'todo' || type === 'milestone') && !pool && (
            <Field label={type === 'milestone' ? '截止日期' : '条目日期'}>
              <DatePicker
                value={dueDate}
                onChange={(e) => {
                  setDueDate(e.target.value);
                  if (!e.target.value) setDueTime('');
                }}
              />
            </Field>
          )}
          {type === 'milestone' && !pool && (
            <>
              <Field label="截止时刻">
                <input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
              </Field>
            </>
          )}
          {type === 'todo' && kind === 'todo' && (
            <>
              <Field label="交接方式">
                <select
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as typeof direction)}
                >
                  {Object.entries(directionLabel).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              {direction !== 'self' && (
                <Field label="联系人">
                  <input required value={person} onChange={(e) => setPerson(e.target.value)} />
                </Field>
              )}
            </>
          )}
          {(type === 'todo' || type === 'milestone') && (
            <Field label="批注 / 纪要">
              <textarea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} />
            </Field>
          )}
        </details>
        <ErrorMessage message={error} />
        <div className="form-actions">
          <Button type="button" onClick={close}>
            取消
          </Button>
          <Button type="submit" className="primary" disabled={busy}>
            {busy ? '正在保存…' : '保存'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
