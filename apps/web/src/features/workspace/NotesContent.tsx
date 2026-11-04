import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { CheckIcon, Cross2Icon, Pencil2Icon } from '@radix-ui/react-icons';
import { readContent, saveContent } from '../../api';
import { Button, ErrorMessage, Field } from '../../components/ui';
const Markdown = lazy(() => import('react-markdown'));
export function NotesContent({
  id,
  revision,
  editable = false,
  compact = false,
  reload,
  onDirtyChange,
}: {
  id: string;
  revision?: string;
  editable?: boolean;
  compact?: boolean;
  reload?: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [body, setBody] = useState(''),
    [loadedRevision, setLoadedRevision] = useState('');
  const [editing, setEditing] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  useEffect(() => {
    let active = true;
    if (dirty.current) return;
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
  }, [id, revision]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  return (
    <section className="detail-section notes-content">
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
