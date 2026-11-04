import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { CheckIcon, Cross2Icon, Pencil2Icon } from '@radix-ui/react-icons';
import { readContent, saveContent } from '../../api';
import { Button, ErrorMessage, Field } from '../../components/ui';
import { useDraftState, useDraftSaving } from '../drafts/useDraftState';
const Markdown = lazy(() => import('react-markdown'));
export function NotesContent({
  id,
  revision,
  editable = false,
  compact = false,
  draftScope,
  reload,
  onDirtyChange,
}: {
  id: string;
  revision?: string;
  editable?: boolean;
  compact?: boolean;
  draftScope: string;
  reload?: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useDraftState<{ body: string; revision: string } | null>(
    `${draftScope}:notes:${id}`,
    null,
  );
  const [body, setBody] = useState(draft?.body ?? ''),
    [loadedRevision, setLoadedRevision] = useState(draft?.revision ?? '');
  const [editing, setEditing] = useState(Boolean(draft)),
    [error, setError] = useState(''),
    [busy, setBusy] = useDraftSaving(`${draftScope}:notes:${id}`);
  const dirty = useRef(Boolean(draft));
  useEffect(() => {
    let active = true;
    if (busy) return;
    if (dirty.current && draft === null) {
      dirty.current = false;
      setEditing(false);
      onDirtyChange?.(false);
    }
    if (dirty.current) {
      onDirtyChange?.(true);
      return;
    }
    void readContent(id)
      .then((value) => {
        if (active && !dirty.current) {
          setBody(value.body);
          setLoadedRevision(value.revision);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [id, revision, draft, busy]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  return (
    <section inert={busy} className="detail-section notes-content">
      <div className="section-heading">
        <h3>Notes</h3>
        {editable && !editing && (
          <Button aria-label="编辑正文" title="编辑正文" onClick={() => setEditing(true)}>
            {compact ? <Pencil2Icon /> : '编辑正文'}
          </Button>
        )}
      </div>
      {editing ? (
        <>
          <Field label="Notes 正文">
            <textarea
              rows={20}
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setDraft({ body: e.target.value, revision: loadedRevision });
                dirty.current = true;
                onDirtyChange?.(true);
              }}
            />
          </Field>
          <div className="actions">
            <Button
              aria-label="取消"
              disabled={busy}
              onClick={() => {
                if (dirty.current && !window.confirm('放弃尚未保存的正文？')) return;
                dirty.current = false;
                setDraft(null);
                onDirtyChange?.(false);
                setEditing(false);
                void readContent(id)
                  .then((value) => {
                    setBody(value.body);
                    setLoadedRevision(value.revision);
                  })
                  .catch((e) => setError(String(e)));
              }}
            >
              {compact ? <Cross2Icon /> : '取消'}
            </Button>
            <Button
              className="primary"
              aria-label="保存正文"
              title="保存正文"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError('');
                void saveContent(id, body, loadedRevision)
                  .then(async (value) => {
                    setLoadedRevision(value.revision);
                    dirty.current = false;
                    setDraft(null);
                    onDirtyChange?.(false);
                    setEditing(false);
                    await reload?.();
                  })
                  .catch((e) => setError(String(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {compact ? <CheckIcon /> : '保存正文'}
            </Button>
          </div>
        </>
      ) : (
        <div className="markdown-body">
          <Suspense fallback={null}>
            <Markdown skipHtml>{body}</Markdown>
          </Suspense>
        </div>
      )}
      <ErrorMessage message={error} />
    </section>
  );
}
