import { useEffect, useRef, useState } from 'react';
import { clock, localDay, minutes, type Snapshot } from '../../../../../packages/domain/index';
import { announceSaved } from '../../components/SaveFeedback';
import { createRecord, deleteActual, save } from '../../api';
import { Modal, Field, ActionButton, ErrorMessage, DatePicker } from '../../components/ui';
import { useDraftState, useDraftSaving, clearDraft } from '../drafts/useDraftState';
import type { Editor } from '../../types/editor';
import type { RecordSource } from './types';
import { useActualAssociations } from './useActualAssociations';
import { HalfHourGrid, halfHourAvailability } from './HalfHourGrid';
export function ActualRecordForm({
  editor,
  snapshot,
  close,
  reload,
  embedded = false,
  mobile = false,
  source,
  onDirtyChange,
  onSaved,
}: {
  editor: Editor;
  snapshot: Snapshot;
  close: () => void;
  reload: () => Promise<void>;
  embedded?: boolean;
  mobile?: boolean;
  source?: RecordSource;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: (id: string, date: string) => void;
}) {
  const old = editor.entry?.data.type === 'actual' ? editor.entry.data : undefined;
  const draftKey = `${snapshot.root}:actual:${old?.id ?? 'new'}`;
  const now = new Date(),
    minute = Math.min(1439, now.getHours() * 60 + now.getMinutes());
  const defaultDate = String(editor.defaults?.date ?? localDay());
  const availableDefaults = halfHourAvailability(snapshot.entries, defaultDate, old?.id);
  const recent = availableDefaults.slice(0, Math.floor(minute / 30)).lastIndexOf(true);
  const defaultSlot = Math.max(0, recent >= 0 ? recent : availableDefaults.findIndex(Boolean));
  const defaultStart = String(editor.defaults?.startTime ?? clock(defaultSlot * 30));
  const defaultEnd = String(editor.defaults?.endTime ?? clock((defaultSlot + 1) * 30));
  const [baseRevision] = useDraftState(draftKey + ':revision', editor.entry?.revision ?? '');
  const [id] = useDraftState(draftKey + ':id', () => old?.id ?? crypto.randomUUID());
  const [startTime, setStart] = useDraftState(draftKey + ':start', old?.startTime ?? defaultStart);
  const [endTime, setEnd] = useDraftState(draftKey + ':end', old?.endTime ?? defaultEnd);
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
  useEffect(() => {
    if (old || edited.current || selection.itemIds.length || selection.milestoneIds.length || busy)
      return;
    setDate(defaultDate);
    setStart(defaultStart);
    setEnd(defaultEnd);
  }, [
    old,
    defaultDate,
    defaultStart,
    defaultEnd,
    selection.itemIds.length,
    selection.milestoneIds.length,
    busy,
  ]);
  const form = (
    <form
      className="actual-record-form"
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
          if (mobile) announceSaved();
          clearDraft(draftKey);
          onDirtyChange?.(false);
          close();
          onSaved?.(id, date);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="actual-entry-main">
        {embedded && date !== localDay() && (
          <p className={`capture-date${date !== localDay() ? ' historical-date' : ''}`}>
            记录日期 · {date}
            {date !== localDay() && <strong>正在记录历史日期</strong>}
          </p>
        )}
        <HalfHourGrid
          available={halfHourAvailability(snapshot.entries, date, old?.id)}
          startTime={startTime}
          endTime={endTime}
          onChange={(start, end) => {
            edited.current = true;
            setEdited(true);
            onDirtyChange?.(true);
            setStart(start);
            setEnd(end);
          }}
        />
        <div className="actual-date-field">
          {(!embedded || date !== defaultDate) && (
            <Field label="记录日期" wide>
              <DatePicker
                value={date}
                onChange={(e) => e.target.value && setDate(e.target.value)}
              />
            </Field>
          )}
        </div>
        <output className="selected-time-range" aria-label="已选时间">
          {startTime}–{endTime} · {minutes(endTime) - minutes(startTime)} 分钟
        </output>
        <Field label="具体事件">
          <textarea
            required
            autoFocus={!embedded}
            rows={mobile ? 3 : 4}
            placeholder="做了什么？"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
      <ErrorMessage message={error} />
      <div className="form-actions">
        {old && (
          <ActionButton action="delete" type="button" disabled={busy} onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await deleteActual(editor.entry!);
              await reload();
              clearDraft(draftKey);
              onDirtyChange?.(false);
              close();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }} />
        )}
        <ActionButton
          action="cancel"
          type="button"
          onClick={() => {
            if (embedded || !wasEdited) {
              clearDraft(draftKey);
              onDirtyChange?.(false);
            }
            close();
          }}
        />
        <ActionButton action="save" type="submit" disabled={busy} />
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
