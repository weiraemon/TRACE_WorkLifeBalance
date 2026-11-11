import { useState } from 'react';
import {
  directionLabel,
  milestoneTags,
  isSpaceItem,
  type Snapshot,
} from '../../../../../packages/domain/index';
import { Button, Field, DatePicker, Modal, ErrorMessage } from '../../components/ui';
import { createRecord, save } from '../../api';
import { ImportancePicker } from '../../components/Importance';
import type { Editor } from '../../types/editor';
import { WorkLocationPicker, initialLocation } from './WorkLocationPicker';
import { useDraftState, useDraftSaving, clearDraft } from '../drafts/useDraftState';
import { parseQuickCapture } from '../capture/quickCaptureParser';
export const spaceLabel = { project: '项目', workline: '业务线', milestone: '节点', todo: '条目' };
export function WorkItemForm({
  editor,
  snapshot,
  close,
  reload,
  onDirtyChange,
}: {
  editor: Editor;
  snapshot: Snapshot;
  close: () => void;
  reload: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const type = editor.type as keyof typeof spaceLabel;
  const item = editor.entry && isSpaceItem(editor.entry.data) ? editor.entry.data : undefined;
  const defaults = editor.defaults ?? {};
  const draftKey = `${snapshot.root}:work:${item?.id ?? JSON.stringify([type, defaults])}`;
  const [baseRevision] = useDraftState(draftKey + ':revision', editor.entry?.revision ?? '');
  const [wasEdited, setEdited] = useDraftState(draftKey + ':edited', false);
  const closeForm = () => {
    if (!wasEdited) clearDraft(draftKey);
    close();
  };
  const [title, setTitle] = useDraftState(
    draftKey + ':title',
    item?.title ?? String(defaults.title ?? ''),
  );
  const [sourceText, setSourceText] = useDraftState(draftKey + ':sourceText', '');
  const [kind, setKind] = useDraftState<'todo' | 'idea'>(
    draftKey + ':kind',
    item?.type === 'todo' ? item.kind : defaults.kind === 'idea' ? 'idea' : 'todo',
  );
  const [location, setLocation] = useDraftState(draftKey + ':location', () =>
    initialLocation(snapshot.entries, item, defaults),
  );
  const [importance, setImportance] = useDraftState(
    draftKey + ':importance',
    item?.importance ?? 1,
  );
  const [dueDate, setDueDate] = useDraftState(
    draftKey + ':dueDate',
    item?.type === 'milestone' || item?.type === 'todo' ? (item.dueDate ?? '') : '',
  );
  const [dueTime, setDueTime] = useDraftState(
    draftKey + ':dueTime',
    item?.type === 'milestone' ? (item.dueTime ?? '') : '',
  );
  const [tags, setTags] = useDraftState(
    draftKey + ':tags',
    item?.type === 'milestone' ? item.tags.join('，') : '',
  );
  const [direction, setDirection] = useDraftState(
    draftKey + ':direction',
    item?.type === 'todo' ? item.direction : 'self',
  );
  const [person, setPerson] = useDraftState(
    draftKey + ':person',
    item?.type === 'todo' ? item.person : '',
  );
  const [comment, setComment] = useDraftState(draftKey + ':comment', '');
  const [commentId] = useDraftState(draftKey + ':commentId', () => crypto.randomUUID());
  const [recordId] = useDraftState(draftKey + ':recordId', () => item?.id ?? crypto.randomUUID());
  const [error, setError] = useState(''),
    [busy, setBusy] = useDraftSaving(draftKey);
  const pool = item?.type === 'milestone' && item.pool;
  const knownTags = [
    ...new Set([
      ...milestoneTags,
      ...snapshot.entries.flatMap((e) => (e.data.type === 'milestone' ? e.data.tags : [])),
    ]),
  ];
  const applyParsedText = (value: string) => {
    setEdited(true);
    onDirtyChange?.(true);
    const parsed = parseQuickCapture(value, snapshot.entries);
    const line = snapshot.entries.find(
      (entry) => entry.data.type === 'workline' && entry.data.id === parsed.lineId,
    );
    setTitle(parsed.title);
    setImportance(parsed.importance);
    setDueDate(parsed.dueDate ?? '');
    setDueTime(parsed.dueTime ?? '');
    setTags(parsed.tags.join('，'));
    if (!location.lineId && line?.data.type === 'workline')
      setLocation({ projectId: line.data.projectId, lineId: line.data.id, milestoneId: '' });
  };
  return (
    <Modal
      className="editor-dialog"
      title={`${item ? '编辑' : '新增'}${type === 'todo' ? kind.toUpperCase() : spaceLabel[type]}`}
      onClose={closeForm}
    >
      <form
        inert={busy}
        onChangeCapture={() => {
          setEdited(true);
          onDirtyChange?.(true);
        }}
        onClickCapture={(event) => {
          if ((event.target as Element).closest('.importance-picker')) {
            setEdited(true);
            onDirtyChange?.(true);
          }
        }}
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
            await save(
              data,
              editor.entry ? { ...editor.entry, revision: baseRevision } : undefined,
              {
                comments: comment.trim()
                  ? [{ id: commentId, targetId: recordId, text: comment }]
                  : [],
              },
            );
            await reload();
            clearDraft(draftKey);
            onDirtyChange?.(false);
            close();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {type === 'milestone' && !pool && (
          <div className="node-smart-capture">
            <Field label="粘贴微信消息" wide>
              <textarea
                rows={3}
                value={sourceText}
                placeholder="例如：明天上午九点半所里一块讨论下推进方案"
                onChange={(e) => setSourceText(e.target.value)}
                onPaste={(e) => {
                  const value = e.clipboardData.getData('text');
                  if (!value.trim()) return;
                  e.preventDefault();
                  setSourceText(value);
                  applyParsedText(value);
                }}
              />
            </Field>
            <Button
              type="button"
              onClick={() => applyParsedText(sourceText)}
              disabled={!sourceText.trim()}
            >
              识别时间和节点
            </Button>
            {sourceText && (
              <p className="hint">
                会识别“明天 / 10月29日 / 周二 / 下周二”、9点 / 九点 /
                9.、上午下午和半点；识别不到业务线时请手动选择。
              </p>
            )}
          </div>
        )}
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
            originalMilestoneId={item?.type === 'todo' ? item.milestoneId : undefined}
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
        <div className="optional-settings">
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
        </div>
        <ErrorMessage message={error} />
        <div className="form-actions">
          <Button type="button" onClick={closeForm}>
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
