import { useState } from 'react';
import {
  directionLabel,
  lineKinds,
  lineKindLabel,
  milestoneKinds,
  milestoneKindLabel,
  statuses,
  statusLabel,
  isSpaceItem,
  type Snapshot,
  type SpaceItem,
} from '../../../../packages/domain/index';
import { Button, Field, DatePicker, Modal, ErrorMessage } from '../components/ui';
import { createRecord, save } from '../api';
import { ImportancePicker } from '../components/Importance';
import { ResourcePicker } from './ReferenceForm';
import type { Editor } from './editor';
import { WorkLocationPicker, initialLocation } from './WorkLocationPicker';
export const spaceLabel = {
  project: '项目',
  workline: '业务线',
  milestone: '关键节点',
  todo: '待办',
};
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
  const type = editor.type as SpaceItem['type'];
  const item = editor.entry && isSpaceItem(editor.entry.data) ? editor.entry.data : undefined;
  const defaults = editor.defaults ?? {};
  const [title, setTitle] = useState(item?.title ?? String(defaults.title ?? ''));
  const [importance, setImportance] = useState(
    item?.importance ?? Number(defaults.importance ?? 3),
  );
  const [location, setLocation] = useState(() => initialLocation(snapshot.entries, item, defaults));
  const [direction, setDirection] = useState(item?.type === 'todo' ? item.direction : 'self');
  const [person, setPerson] = useState(item?.type === 'todo' ? item.person : '');
  const [estimate, setEstimate] = useState(
    item?.type === 'todo' ? String(item.estimatedMinutes ?? '') : '',
  );
  const [kind, setKind] = useState(
    item && 'kind' in item
      ? item.kind
      : String(defaults.kind ?? (type === 'workline' ? 'research' : 'milestone')),
  );
  const [dueDate, setDueDate] = useState(
    item?.type === 'milestone' || item?.type === 'todo' ? (item.dueDate ?? '') : '',
  );
  const [dueTime, setDueTime] = useState(item?.type === 'milestone' ? (item.dueTime ?? '') : '');
  const [status, setStatus] = useState(item?.status ?? 'Ready');
  const [description, setDescription] = useState(item?.description ?? '');
  const [resources, setResources] = useState(item?.resourceIds ?? []);
  const linkedMarkdown = snapshot.entries.find(
    ({ data }) =>
      resources.includes(data.id) &&
      data.type === 'resource' &&
      data.location === 'vault' &&
      /\.md$/i.test(data.target),
  );
  const [markdownPath, setMarkdownPath] = useState(() => {
    const data = linkedMarkdown?.data;
    return data?.type === 'resource'
      ? (snapshot.entries.find((e) => e.data.id === data.noteId)?.path ?? data.target)
      : '';
  });
  const markdownFiles = snapshot.files
    .filter(
      (file) =>
        !file.directory &&
        /\.md$/i.test(file.path) &&
        !snapshot.entries.some((e) => e.path === file.path && e.data.type !== 'resource'),
    )
    .map((file) => file.path)
    .sort();
  const [order, setOrder] = useState(item?.order ?? Number(defaults.order ?? 0));
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const parentKey =
    type === 'workline' ? 'projectId' : type === 'milestone' ? 'lineId' : 'milestoneId';
  const hasContext = type !== 'project' && Boolean(location[parentKey]);
  const breadcrumb = [
    location.projectId,
    type !== 'workline' && location.lineId,
    type === 'todo' && location.milestoneId,
  ]
    .filter(Boolean)
    .map((id) => snapshot.entries.find((e) => e.data.id === id)?.data)
    .map((r) => (r && 'title' in r ? r.title : ''))
    .join(' / ');
  return (
    <Modal title={`${item ? '编辑' : '新增'}${spaceLabel[type]}`} onClose={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            let resourceIds = resources;
            if (type === 'milestone') {
              resourceIds = [];
              if (markdownPath) {
                const existing = snapshot.entries.find(
                  ({ data }) =>
                    data.type === 'resource' &&
                    data.location === 'vault' &&
                    (data.target === markdownPath ||
                      snapshot.entries.some(
                        (e) => e.data.id === data.noteId && e.path === markdownPath,
                      )),
                );
                const resource =
                  existing ??
                  (await save(
                    createRecord('resource', {
                      title: markdownPath.split('/').pop()?.replace(/\.md$/i, ''),
                      target: markdownPath,
                      location: 'vault',
                    }),
                  ));
                resourceIds = [resource.data.id];
                setResources(resourceIds);
              }
            }
            const fields = {
              ...(item ?? {}),
              title,
              importance,
              description,
              status: !item && type === 'todo' && direction === 'from' ? 'Waiting' : status,
              resourceIds,
              order,
              ...(type !== 'project' ? { [parentKey]: location[parentKey] } : {}),
              ...(type === 'workline' || type === 'milestone' ? { kind } : {}),
              ...(type === 'milestone'
                ? { dueDate: dueDate || null, dueTime: dueTime || null }
                : {}),
              ...(type === 'todo'
                ? {
                    dueDate: dueDate || null,
                    direction,
                    person: direction === 'self' ? '' : person,
                    estimatedMinutes: estimate ? Number(estimate) : null,
                  }
                : {}),
            };
            await save(createRecord(type, fields), editor.entry);
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
          <input
            required
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={
              type === 'todo'
                ? '具体要做什么？'
                : type === 'milestone'
                  ? '下一次讨论、审阅或交付'
                  : '给这条工作线索起个名字'
            }
          />
        </Field>
        {type !== 'project' &&
          (hasContext ? (
            <details className="context-disclosure">
              <summary>{breadcrumb} · 更换归属</summary>
              <WorkLocationPicker
                entries={snapshot.entries}
                level={type}
                value={location}
                onChange={setLocation}
              />
            </details>
          ) : (
            <WorkLocationPicker
              entries={snapshot.entries}
              level={type}
              value={location}
              onChange={setLocation}
            />
          ))}
        {type === 'milestone' && (
          <div className="form-grid">
            <Field label="截止日期">
              <DatePicker value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
            <Field label="截止时刻（可选）">
              <input
                type="time"
                step="60"
                value={dueTime}
                onChange={(e) => setDueTime(e.target.value)}
              />
            </Field>
          </div>
        )}
        {type === 'todo' && (
          <Field label="待办日期（可选）">
            <DatePicker value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        )}
        <div className="inline-field">
          <span>重要性</span>
          <ImportancePicker value={importance} onChange={setImportance} />
        </div>
        {type === 'todo' && (
          <>
            <div className="segmented direction-picker" role="group" aria-label="待办方向">
              {(['self', 'to', 'from'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={direction === d}
                  onClick={() => setDirection(d)}
                >
                  {directionLabel[d]}
                </button>
              ))}
            </div>
            {direction !== 'self' && (
              <Field label="联系人">
                <input
                  required
                  value={person}
                  onChange={(e) => setPerson(e.target.value)}
                  placeholder="需要联系谁？"
                />
              </Field>
            )}
          </>
        )}
        <details className="optional-settings">
          <summary>可选设置</summary>
          {type === 'workline' && (
            <Field label="业务线类型">
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {lineKinds.map((k) => (
                  <option key={k} value={k}>
                    {lineKindLabel[k]}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {type === 'milestone' && (
            <Field label="节点类型">
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {milestoneKinds.map((k) => (
                  <option key={k} value={k}>
                    {milestoneKindLabel[k]}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {type === 'todo' && (
            <Field label="预计用时（分钟，可不填）">
              <input
                type="number"
                min="5"
                max="1440"
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
              />
            </Field>
          )}
          <Field label="状态">
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {statusLabel[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="说明">
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {type !== 'milestone' && (
            <Field label="排列顺序">
              <input
                type="number"
                step="any"
                value={order}
                onChange={(e) => setOrder(Number(e.target.value))}
              />
            </Field>
          )}
          {type === 'milestone' ? (
            <Field label="绑定 Markdown（可选）">
              <select value={markdownPath} onChange={(e) => setMarkdownPath(e.target.value)}>
                <option value="">不绑定</option>
                {markdownPath && !markdownFiles.includes(markdownPath) && (
                  <option value={markdownPath}>{markdownPath}（文件未找到）</option>
                )}
                {markdownFiles.map((filename) => (
                  <option key={filename} value={filename}>
                    {filename}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <ResourcePicker snapshot={snapshot} values={resources} onChange={setResources} />
          )}
        </details>
        <ErrorMessage message={error} />
        <div className="form-actions">
          <Button type="button" onClick={close}>
            取消
          </Button>
          <Button type="submit" className="primary" disabled={busy}>
            {busy ? '正在保存…' : '保存到 Vault'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
