import { useState } from 'react';
import type { Entry } from '../../../../../packages/domain/index';
import { save } from '../../api';
import { Button, Modal, Field, ErrorMessage } from '../../components/ui';
import { useDraftState, useDraftSaving, clearDraft } from '../drafts/useDraftState';
export function CommentForm({
  entry,
  draftScope,
  close,
  reload,
  onDirtyChange,
}: {
  entry: Entry;
  draftScope: string;
  close: () => void;
  reload: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const draftKey = `${draftScope}:comment:${entry.data.id}`;
  const [baseRevision] = useDraftState(draftKey + ':revision', entry.revision);
  const closeForm = () => {
    if (!text.trim()) clearDraft(draftKey);
    close();
  };
  const [text, setText] = useDraftState(draftKey + ':text', ''),
    [error, setError] = useState(''),
    [busy, setBusy] = useDraftSaving(draftKey);
  const [id] = useDraftState(draftKey + ':id', () => crypto.randomUUID());
  return (
    <Modal
      className="editor-dialog"
      title={`添加批注 · ${'title' in entry.data ? entry.data.title : ''}`}
      onClose={closeForm}
    >
      <form
        inert={busy}
        onChangeCapture={() => onDirtyChange?.(true)}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await save(
              entry.data,
              { ...entry, revision: baseRevision },
              { comments: [{ id, targetId: entry.data.id, text }] },
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
        <Field label="批注 / 纪要">
          <textarea
            required
            autoFocus
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <ErrorMessage message={error} />
        <div className="form-actions">
          <Button type="button" onClick={closeForm}>
            取消
          </Button>
          <Button type="submit" className="primary" disabled={busy}>
            保存批注
          </Button>
        </div>
      </form>
    </Modal>
  );
}
