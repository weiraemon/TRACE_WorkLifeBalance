import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { Pencil2Icon } from '@radix-ui/react-icons';
import type { NoteContent } from '../../../../../packages/domain/index';
import { readContent, saveContent } from '../../api';
import { ActionButton, Button, ErrorMessage, Field } from '../../components/ui';
import { useDraftState, useDraftSaving } from '../drafts/useDraftState';
const Markdown = lazy(() => import('react-markdown'));
type Draft = { body: string; revision: string; comments?: Array<{ text: string }> };

function mergedBody(body: string, comments?: Array<{ text: string }>) {
  return [body.trim(), ...(comments ?? []).map((comment) => comment.text.trim())]
    .filter(Boolean)
    .join('\n\n');
}

function ContentPreview({ value }: { value: NoteContent }) {
  return (
    <div className="markdown-body">
      <Suspense fallback={null}>
        <Markdown skipHtml>{mergedBody(value.body, value.comments)}</Markdown>
      </Suspense>
    </div>
  );
}

export function NotesContent({
  id,
  revision,
  editable = false,
  compact = false,
  draftScope,
  reload,
  onDirtyChange,
  provided,
  title = 'Notes',
  startEditing = false,
  onSaved,
}: {
  id: string;
  revision?: string;
  editable?: boolean;
  compact?: boolean;
  draftScope: string;
  reload?: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  provided?: NoteContent;
  title?: string;
  startEditing?: boolean;
  onSaved?: () => void;
}) {
  const key = `${draftScope}:note-content:${id}`;
  const [draft, setDraft] = useDraftState<Draft | null>(key, null);
  const [value, setValue] = useState<NoteContent | null>(provided ?? null);
  const [body, setBody] = useState(
    draft
      ? mergedBody(draft.body, draft.comments)
      : mergedBody(provided?.body ?? '', provided?.comments),
  );
  const [loadedRevision, setLoadedRevision] = useState(draft?.revision ?? provided?.revision ?? '');
  const [editing, setEditing] = useState(startEditing || Boolean(draft));
  const [activeId, setActiveId] = useDraftState(`${draftScope}:notes-active:${id}`, '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useDraftSaving(key);
  const dirty = useRef(Boolean(draft));
  const accept = (next: NoteContent) => {
    setValue(next);
    setBody(mergedBody(next.body, next.comments));
    setLoadedRevision(next.revision);
    setError('');
  };
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
    if (provided) {
      accept(provided);
      return;
    }
    void readContent(id)
      .then((next) => {
        if (active && !dirty.current) accept(next);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [id, revision, provided, draft, busy]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const change = (nextBody: string) => {
    setBody(nextBody);
    setDraft({ body: nextBody, revision: loadedRevision });
    dirty.current = true;
    onDirtyChange?.(true);
  };
  if (value?.sections)
    return (
      <section className="detail-section notes-content">
        <h3>Notes</h3>
        <ContentPreview value={{ ...value, body: value.intro ?? '', comments: [] }} />
        {value.sections.map((part) => (
          <section
            className="detail-section"
            key={part.id}
            data-space-id={part.id}
            aria-label={`内容 · ${part.title}`}
          >
            {activeId === part.id ? (
              <NotesContent
                id={part.id}
                provided={part}
                title={part.title}
                editable
                compact={compact}
                startEditing
                draftScope={draftScope}
                onDirtyChange={onDirtyChange}
                onSaved={() => setActiveId('')}
                reload={async () => {
                  accept(await readContent(id));
                  await reload?.();
                }}
              />
            ) : (
              <>
                <div className="section-heading">
                  <div
                    role="heading"
                    aria-level={part.kind === 'milestone' ? 2 : 3}
                    aria-label={part.heading}
                  >
                    <button
                      className="notes-section-title"
                      aria-label={`编辑内容 · ${part.title}`}
                      onClick={() => setActiveId(part.id)}
                    >
                      {part.heading}
                    </button>
                  </div>
                </div>
                <ContentPreview value={part} />
              </>
            )}
          </section>
        ))}
        <ErrorMessage message={error} />
      </section>
    );
  return (
    <section inert={busy} className="detail-section notes-content">
      <div className="section-heading">
        <h3>{title}</h3>
        {editable && !editing && (
          <Button aria-label="编辑内容" title="编辑内容" onClick={() => setEditing(true)}>
            {compact ? <Pencil2Icon /> : '编辑内容'}
          </Button>
        )}
      </div>
      {editing && editable ? (
        <>
          <Field label="正文">
            <textarea
              disabled={!loadedRevision}
              rows={8}
              value={body}
              onChange={(event) => change(event.target.value)}
            />
          </Field>
          <div className="form-actions notes-content-actions">
            <ActionButton
              action="cancel"
              aria-label="取消"
              onClick={() => {
                if (dirty.current && !window.confirm('放弃尚未保存的内容？')) return;
                dirty.current = false;
                setDraft(null);
                onDirtyChange?.(false);
                setEditing(false);
                if (value) accept(value);
                onSaved?.();
              }}
            />
            <ActionButton
              action="save"
              aria-label="保存内容"
              disabled={!loadedRevision || busy}
              onClick={() => {
                setBusy(true);
                setError('');
                void saveContent(
                  id,
                  body,
                  loadedRevision,
                  [],
                )
                  .then(async (next) => {
                    accept(next);
                    dirty.current = false;
                    setDraft(null);
                    onDirtyChange?.(false);
                    setEditing(false);
                    await reload?.();
                    onSaved?.();
                  })
                  .catch((e) => setError(String(e)))
                  .finally(() => setBusy(false));
              }}
            />
          </div>
        </>
      ) : (
        value && <ContentPreview value={value} />
      )}
      <ErrorMessage message={error} />
    </section>
  );
}
