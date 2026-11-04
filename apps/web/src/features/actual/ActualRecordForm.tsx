import { useEffect, useRef, useState } from 'react';
import { clock, localDay, type Snapshot } from '../../../../../packages/domain/index';
import { createRecord, save } from '../../api';
import { Modal, Field, Button, ErrorMessage, DatePicker } from '../../components/ui';
import { useDraftState, useDraftSaving, clearDraft } from '../drafts/useDraftState';
import type { Editor } from '../../types/editor';
import type { RecordSource } from './types';
import { useActualAssociations } from './useActualAssociations';
import { ActualAssociationPicker } from './ActualAssociationPicker';
export function ActualRecordForm({
  editor,
  snapshot,
  close,
  reload,
  embedded = false,
  source,
  onDirtyChange,
}: {
  editor: Editor;
  snapshot: Snapshot;
  close: () => void;
  reload: () => Promise<void>;
  embedded?: boolean;
  source?: RecordSource;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const old = editor.entry?.data.type === 'actual' ? editor.entry.data : undefined;
  const draftKey = `${snapshot.root}:actual:${old?.id ?? 'new'}`;
  const now = new Date(),
    minute = Math.min(1439, now.getHours() * 60 + now.getMinutes());
  const [baseRevision] = useDraftState(draftKey + ':revision', editor.entry?.revision ?? '');
  const [id] = useDraftState(draftKey + ':id', () => old?.id ?? crypto.randomUUID());
  const [startTime, setStart] = useDraftState(
    draftKey + ':start',
    old?.startTime ?? String(editor.defaults?.startTime ?? clock(Math.max(0, minute - 30))),
  );
  const [endTime, setEnd] = useDraftState(
    draftKey + ':end',
    old?.endTime ?? String(editor.defaults?.endTime ?? clock(minute || 1)),
  );
  const [description, setDescription] = useDraftState(
    draftKey + ':description',
    old?.description ?? '',
  );
  const [date, setDate] = useDraftState(
    draftKey + ':date',
    old?.date ?? String(editor.defaults?.date ?? localDay()),
  );
  const [wasEdited, setEdited] = useDraftState(draftKey + ':edited', false);
  const edited = useRef(wasEdited || Boolean(description));
  const selection = useActualAssociations(snapshot, old, source, draftKey);
  const associationState = JSON.stringify([
    selection.itemIds,
    selection.milestoneIds,
    selection.completeIds,
    selection.comments,
  ]);
  const previousAssociations = useRef(associationState);
  useEffect(() => {
    if (associationState !== previousAssociations.current) {
      previousAssociations.current = associationState;
      onDirtyChange?.(true);
      setEdited(true);
    }
  }, [associationState, onDirtyChange]);
  const [error, setError] = useState(''),
    [busy, setBusy] = useDraftSaving(draftKey);
  const defaultDate = String(editor.defaults?.date ?? localDay());
  useEffect(() => {
    if (old || edited.current || selection.itemIds.length || selection.milestoneIds.length || busy)
      return;
    setDate(defaultDate);
    setStart(String(editor.defaults?.startTime ?? clock(Math.max(0, minute - 30))));
    setEnd(String(editor.defaults?.endTime ?? clock(minute || 1)));
  }, [
    old,
    defaultDate,
    minute,
    editor.defaults?.startTime,
    editor.defaults?.endTime,
    selection.itemIds.length,
    selection.milestoneIds.length,
    busy,
  ]);
  const form = (
    <form
      inert={busy}
      aria-label="实际工作录入"
      onChangeCapture={() => {
        edited.current = true;
        setEdited(true);
        onDirtyChange?.(true);
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await save(
            createRecord('actual', {
              ...(old ?? {}),
              id,
              date,
              startTime,
              endTime,
              description,
              itemIds: selection.itemIds,
              milestoneIds: selection.milestoneIds,
            }),
            editor.entry ? { ...editor.entry, revision: baseRevision } : undefined,
            {
              completeIds: selection.completeIds.filter(
                (target) =>
                  selection.itemIds.includes(target) || selection.milestoneIds.includes(target),
              ),
              comments: Object.entries(selection.comments)
                .filter(
                  ([target, value]) =>
                    (selection.itemIds.includes(target) ||
                      selection.milestoneIds.includes(target)) &&
                    value.text.trim(),
                )
                .map(([targetId, value]) => ({ ...value, targetId, date })),
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
      {embedded && (
        <p className={`capture-date${date !== localDay() ? ' historical-date' : ''}`}>
          记录日期 · {date}
          {date !== localDay() && <strong>正在记录历史日期</strong>}
        </p>
      )}
      <Field label="具体事件">
        <textarea
          required
          autoFocus={!embedded}
          rows={2}
          placeholder="写下这段时间具体做了什么…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="actual-time-fields">
        {(!embedded || date !== defaultDate) && (
          <Field label="记录日期" wide>
            <DatePicker value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </Field>
        )}
        <Field label="开始时间">
          <input
            type="time"
            required
            value={startTime}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="结束时间">
          <input
            type="time"
            required
            value={endTime === '24:00' ? '00:00' : endTime}
            onChange={(e) => setEnd(e.target.value === '00:00' ? '24:00' : e.target.value)}
          />
          {endTime === '24:00' && <small>当日 24:00</small>}
        </Field>
      </div>
      <ActualAssociationPicker snapshot={snapshot} selection={selection} date={date} />
      <ErrorMessage message={error} />
      <div className="form-actions">
        <Button
          type="button"
          onClick={() => {
            if (embedded || !wasEdited) {
              clearDraft(draftKey);
              onDirtyChange?.(false);
            }
            close();
          }}
        >
          {embedded ? '清空' : '取消'}
        </Button>
        <Button type="submit" className="primary" disabled={busy}>
          {busy ? '正在保存…' : '保存实际工作'}
        </Button>
      </div>
    </form>
  );
  return embedded ? (
    form
  ) : (
    <Modal
      className="editor-dialog"
      title={`${old ? '编辑' : '记录'}实际工作 · ${date}`}
      onClose={() => {
        if (!wasEdited) clearDraft(draftKey);
        close();
      }}
    >
      {form}
    </Modal>
  );
}
