import { useState } from 'react';
import type { Entry } from '../../../../../packages/domain/index';
import { save } from '../../api';
import { Button, Modal, Field, ErrorMessage } from '../../components/ui';
export function CommentForm({
  entry,
  close,
  reload,
}: {
  entry: Entry;
  close: () => void;
  reload: () => Promise<void>;
}) {
  const [text, setText] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [id] = useState(() => crypto.randomUUID());
  return (
    <Modal
      className="editor-dialog"
      title={`添加批注 · ${'title' in entry.data ? entry.data.title : ''}`}
      onClose={close}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await save(entry.data, entry, { comments: [{ id, targetId: entry.data.id, text }] });
            await reload();
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
          <Button type="button" onClick={close}>
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
