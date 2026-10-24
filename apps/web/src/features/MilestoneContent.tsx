import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import type { MilestoneContent as Content, Snapshot } from '../../../../packages/domain/index';
import { noteKinds, noteKindLabel, noteKindFromPath } from '../../../../packages/domain/index';
import { openObsidian, openResource, readMilestoneContent, saveMilestoneContent } from '../api';
import { Button, ErrorMessage } from '../components/ui';

const Markdown = lazy(() => import('react-markdown'));

export function MilestoneContent({
  linkedFile,
  ...props
}: {
  id: string;
  snapshot: Snapshot;
  linkedFile?: { id: string; path: string; kind: (typeof noteKinds)[number] };
  reload: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [active, setActive] = useState<string | undefined>(linkedFile?.id);
  const [resolvedPath, setResolvedPath] = useState('');
  const dirty = useRef(false);
  const onDirtyChange = useCallback(
    (value: boolean) => {
      dirty.current = value;
      props.onDirtyChange(value);
    },
    [props.onDirtyChange],
  );
  const select = (id?: string) => {
    if (active === id) return;
    if (dirty.current && !window.confirm('正文尚未保存，确定放弃并切换文件？')) return;
    setActive(id);
    setResolvedPath('');
  };
  const path = active === linkedFile?.id && resolvedPath ? resolvedPath : linkedFile?.path;
  const kind = noteKindFromPath(path ?? '', linkedFile?.kind);
  return (
    <div className="detail-section">
      <div className="note-tabs" role="group" aria-label="Markdown 文件">
        <Button aria-pressed={!active} onClick={() => select()}>
          节点正文
        </Button>
        {linkedFile && (
          <Button
            className={`note-file note-kind-${kind}`}
            aria-pressed={active === linkedFile.id}
            title={path}
            onClick={() => select(linkedFile.id)}
          >
            <span>{path?.split(/[\\/]/).pop()}</span>
            <small>
              {noteKindLabel[kind]} · {path?.split(/[\\/]/).slice(0, -1).join('/') || '/'}
            </small>
          </Button>
        )}
      </div>
      <MilestoneEditor
        {...props}
        key={active ?? 'node'}
        resourceId={active}
        onDirtyChange={onDirtyChange}
        onPathChange={setResolvedPath}
      />
    </div>
  );
}

function MilestoneEditor({
  id,
  snapshot,
  reload,
  onDirtyChange,
  resourceId,
  onPathChange,
}: {
  id: string;
  snapshot: Snapshot;
  reload: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  resourceId?: string;
  onPathChange: (path: string) => void;
}) {
  const [content, setContent] = useState<Content | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const dirty = editing && content !== null && draft !== content.body;

  useEffect(() => {
    if (editing) return;
    let ignore = false;
    setError('');
    void readMilestoneContent(id, resourceId)
      .then((value) => {
        if (ignore) return;
        setContent(value);
        setDraft(value.body);
        onPathChange(value.path);
      })
      .catch((e) => {
        if (!ignore) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      ignore = true;
    };
  }, [id, resourceId, snapshot, editing, retry, onPathChange]);

  useEffect(() => {
    onDirtyChange(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);

  const cancel = () => {
    if (dirty && !window.confirm('放弃未保存的正文？')) return;
    setDraft(content?.body ?? '');
    setEditing(false);
  };

  return (
    <section className="milestone-content" aria-label="节点正文" aria-busy={busy}>
      {content && (
        <p className="note-path" title={content.path}>
          {content.path}
        </p>
      )}
      <ErrorMessage message={error} />
      {editing && content ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            try {
              const saved = await saveMilestoneContent(id, draft, content.revision, resourceId);
              setContent(saved);
              setDraft(saved.body);
              setEditing(false);
              await reload();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <textarea
            aria-label="节点正文"
            autoFocus
            rows={16}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="actions">
            <Button type="submit" className="primary" disabled={busy || !dirty}>
              保存正文
            </Button>
            <Button type="button" disabled={busy} onClick={cancel}>
              取消
            </Button>
          </div>
        </form>
      ) : (
        <>
          {content && (
            <div className="markdown-body">
              <Suspense fallback={<p className="preserve">{content.body}</p>}>
                <Markdown
                  skipHtml
                  components={{
                    a: ({ children, href }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {children}
                      </a>
                    ),
                    // shortcut: images show alt text until attachments have an authenticated file route.
                    img: ({ alt }) => <span>{alt}</span>,
                  }}
                >
                  {content.body}
                </Markdown>
              </Suspense>
            </div>
          )}
          {!content && !error && <p role="status">正在读取正文…</p>}
          <div className="actions">
            <Button disabled={!content || Boolean(error)} onClick={() => setEditing(true)}>
              {content?.body.trim() ? '编辑正文' : '写正文'}
            </Button>
            <Button
              onClick={() => {
                setError('');
                void (resourceId ? openResource(resourceId) : openObsidian(id)).catch((e) =>
                  setError(e instanceof Error ? e.message : String(e)),
                );
              }}
            >
              Obsidian ↗
            </Button>
            {error && <Button onClick={() => setRetry((value) => value + 1)}>重新载入正文</Button>}
          </div>
        </>
      )}
    </section>
  );
}
