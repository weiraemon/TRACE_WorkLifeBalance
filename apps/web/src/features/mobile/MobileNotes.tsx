import { useCallback, useRef, useState } from 'react';
import { CheckIcon } from '@radix-ui/react-icons';
import { localDay, type BusinessLine, type Snapshot } from '../../../../../packages/domain/index';
import { readContent, saveContent } from '../../api';
import { Button, ErrorMessage, Field } from '../../components/ui';
import { useDraftState, useDraftSaving } from '../drafts/useDraftState';
import { NotesContent } from '../workspace/NotesContent';

export function MobileNotes({
  snapshot,
  line,
  reload,
  onDirtyChange,
}: {
  snapshot: Snapshot;
  line: BusinessLine;
  reload: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [memo, setMemo] = useDraftState(`${snapshot.root}:memo:${line.id}`, ''),
    [error, setError] = useState(''),
    [busy, setBusy] = useDraftSaving(`${snapshot.root}:memo:${line.id}`);
  const [bodyDirty, setBodyDirty] = useState(false);
  const memoRef = useRef(memo);
  memoRef.current = memo;
  const bodyChanged = useCallback(
    (value: boolean) => {
      setBodyDirty(value);
      onDirtyChange(value || Boolean(memoRef.current.trim()));
    },
    [onDirtyChange],
  );
  const resource = snapshot.entries.find((entry) => entry.data.id === line.notesId);
  return (
    <section className="mobile-notes" aria-label={`笔记 · ${line.title}`}>
      <h1>{line.title}</h1>
      <form
        inert={busy}
        className="mobile-memo"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!memo.trim() || busy || bodyDirty) return;
          setBusy(true);
          setError('');
          try {
            const note = await readContent(line.id);
            await saveContent(
              line.id,
              note.body.trimEnd() + `\n\n## 随手记 · ${localDay()}\n\n${memo.trim()}\n`,
              note.revision,
            );
            setMemo('');
            onDirtyChange(false);
            await reload();
          } catch (error) {
            setError(String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="随手记">
          <textarea
            rows={3}
            value={memo}
            placeholder="记下想法…"
            onChange={(event) => {
              setMemo(event.target.value);
              onDirtyChange(Boolean(event.target.value.trim()) || bodyDirty);
            }}
          />
        </Field>
        <ErrorMessage message={error} />
        <Button
          type="submit"
          className="mobile-note-save"
          aria-label="记到笔记"
          title="记到笔记"
          disabled={!memo.trim() || busy || bodyDirty}
        >
          <CheckIcon />
        </Button>
        {bodyDirty && <p className="hint">先保存或取消下方的正文编辑，再添加随手记。</p>}
      </form>
      <NotesContent
        id={line.id}
        draftScope={snapshot.root}
        revision={resource?.revision}
        editable
        compact
        reload={reload}
        onDirtyChange={bodyChanged}
      />
    </section>
  );
}
