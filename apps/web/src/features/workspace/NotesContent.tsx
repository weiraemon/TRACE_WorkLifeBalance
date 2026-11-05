import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { CheckIcon, Cross2Icon, Pencil2Icon } from '@radix-ui/react-icons';
import type { NoteContent, NoteComment } from '../../../../../packages/domain/index';
import { readContent, saveContent } from '../../api';
import { Button, ErrorMessage, Field } from '../../components/ui';
import { useDraftState, useDraftSaving } from '../drafts/useDraftState';
const Markdown = lazy(() => import('react-markdown'));
type Draft = { body: string; comments: NoteComment[]; revision: string };

function ContentPreview({ value }: { value: NoteContent }) {
  return (
    <div className="markdown-body">
      <Suspense fallback={null}>
        <Markdown skipHtml>{value.body}</Markdown>
        {value.comments?.map((comment) => (
          <div key={comment.id}>
            <small>{comment.date}</small>
            <Markdown skipHtml>{comment.text}</Markdown>
          </div>
        ))}
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
  const [body, setBody] = useState(draft?.body ?? provided?.body ?? '');
  const [comments, setComments] = useState<NoteComment[]>(
    draft?.comments ?? provided?.comments ?? [],
  );
  const [loadedRevision, setLoadedRevision] = useState(draft?.revision ?? provided?.revision ?? '');
  const [editing, setEditing] = useState(startEditing || Boolean(draft));
  const [activeId, setActiveId] = useDraftState(`${draftScope}:notes-active:${id}`, '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useDraftSaving(key);
  const dirty = useRef(Boolean(draft));
  const accept = (next: NoteContent) => {
    setValue(next);
    setBody(next.body);
    setComments(next.comments ?? []);
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
  const change = (nextBody: string, nextComments: NoteComment[]) => {
    setBody(nextBody);
    setComments(nextComments);
    setDraft({ body: nextBody, comments: nextComments, revision: loadedRevision });
    dirty.current = true;
    onDirtyChange?.(true);
  };
  if (value?.sections)
    return (
      <section className="detail-section notes-content">
        <h3>Notes</h3>
        <ContentPreview value={{ ...value, body: value.intro ?? '', comments: [] }} />
        {value.sections.map((part) => (
          <section className="detail-section" key={part.id} aria-label={`内容 · ${part.title}`}>
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
                  {part.kind === 'milestone' ? <h2>{part.heading}</h2> : <h3>{part.heading}</h3>}
                  <Button
                    aria-label={`编辑内容 · ${part.title}`}
                    onClick={() => setActiveId(part.id)}
                  >
                    <Pencil2Icon />
                  </Button>
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
          <Field label="内部正文">
            <textarea
              rows={8}
              value={body}
              onChange={(event) => change(event.target.value, comments)}
            />
          </Field>
          {comments.map((comment, index) => (
            <Field label={`批注 ${index + 1} · ${comment.date}`} key={comment.id}>
              <textarea
                rows={5}
                value={comment.text}
                onChange={(event) =>
                  change(
                    body,
                    comments.map((current) =>
                      current.id === comment.id
                        ? { ...current, text: event.target.value }
                        : current,
                    ),
                  )
                }
              />
            </Field>
          ))}
          <div className="actions">
            <Button
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
            >
              {compact ? <Cross2Icon /> : '取消'}
            </Button>
            <Button
              className="primary"
              aria-label="保存内容"
              disabled={!loadedRevision || busy}
              onClick={() => {
                setBusy(true);
                setError('');
                void saveContent(
                  id,
                  body,
                  loadedRevision,
                  comments.map(({ id, text }) => ({ id, text })),
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
            >
              {compact ? <CheckIcon /> : '保存内容'}
            </Button>
          </div>
        </>
      ) : (
        value && <ContentPreview value={value} />
      )}
      <ErrorMessage message={error} />
    </section>
  );
}
