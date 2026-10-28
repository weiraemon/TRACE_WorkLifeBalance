import { useCallback, useDeferredValue, useEffect, useState, useRef, lazy, Suspense } from 'react';
import { MagnifyingGlassIcon, GearIcon, ReloadIcon } from '@radix-ui/react-icons';
import {
  localDay,
  weekStart,
  isSpaceItem,
  type Entry,
  type Snapshot,
  type DeleteResult,
} from '../../../packages/domain/index';
import { api, load, session, removeSpace } from './api';
import { readLastVault } from './lastVault';
import { spaceSubtree } from '../../../packages/domain/workspace';
import { Button, Modal, EmptyState, ErrorMessage } from './components/ui';
import { Connect, Backup, Appearance } from './features/VaultSettings';
import { ReviewForm } from './features/ReviewForm';
import type { Editor } from './features/editor';
import { WorkItemForm } from './features/WorkItemForm';
import { ActualRecordForm } from './features/ActualRecordForm';
import { CommentForm } from './features/CommentForm';
import { WorkspaceBoard } from './features/WorkspaceBoard';
import { SpaceMenu } from './features/SpaceMenu';
import { QuickEdit } from './features/QuickEdit';
import { SpaceDetails } from './features/SpaceDetails';
import { DeleteSpaceDialog } from './features/DeleteSpaceDialog';
import { Knowledge } from './pages/Knowledge';
import { Review } from './pages/Review';
import { Today } from './pages/Today';
import { MessageInbox } from './features/MessageInbox';
import { WechatSync } from './features/WechatSync';
const Timeline = lazy(() => import('./features/Timeline').then((m) => ({ default: m.Timeline })));
const pages = [
  { id: 'today', name: '今日' },
  { id: 'workspace', name: '工作空间' },
  { id: 'knowledge', name: '知识' },
  { id: 'review', name: '回顾' },
];
export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [loading, setLoading] = useState(true),
    [syncing, setSyncing] = useState(false),
    [error, setError] = useState('');
  const [page, setPage] = useState('today'),
    [selected, setSelected] = useState<string | null>(null),
    [editor, setEditor] = useState<Editor | null>(null),
    [settings, setSettings] = useState(false);
  const [search, setSearch] = useState(''),
    [date, setDate] = useState(localDay()),
    [showArchived, setShowArchived] = useState(false);
  const query = useDeferredValue(search.toLowerCase());
  const [contentDirty, setContentDirty] = useState(false);
  const [syncPanel, setSyncPanel] = useState<'qq' | 'wechat' | null>(null);
  const [pendingMessages, setPendingMessages] = useState(0);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [deletion, setDeletion] = useState<DeleteResult | null>(null);
  const canLeaveContent = () => !contentDirty || window.confirm('正文尚未保存，确定放弃并离开？');
  const reload = useCallback(async () => {
    setSyncing(true);
    try {
      setSnapshot(await load());
    } finally {
      setSyncing(false);
    }
  }, []);
  const run = useCallback((fn: () => Promise<unknown>) => {
    setError('');
    void fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    void session()
      .then(async (s) => {
        if (s.connected) await reload();
        else {
          const root = readLastVault();
          if (root) setSnapshot(await api<Snapshot>('connect', { path: root }));
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [reload]);
  useEffect(() => {
    if (!snapshot) return;
    let pending = false;
    const timer = setInterval(() => {
      if (document.hidden || pending) return;
      pending = true;
      void reload()
        .catch((e) => setError(String(e)))
        .finally(() => {
          pending = false;
        });
    }, 5000);
    return () => clearInterval(timer);
  }, [Boolean(snapshot), reload]);
  useEffect(() => {
    if (!snapshot) {
      setPendingMessages(0);
      return;
    }
    let cancelled = false;
    const readCount = async () => {
      try {
        const view = await api<{ state: { candidates: unknown[] } }>('messages');
        if (!cancelled) setPendingMessages(view.state.candidates.length);
      } catch {
        // Keep the previous count; the sync dialog reports its own errors.
      }
    };
    void readCount();
    const timer = setInterval(readCount, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [snapshot?.vaultId]);
  const goWorkspace = (id?: string) => {
    if (!canLeaveContent()) return;
    setPage('workspace');
    setSearch('');
    setSelected(id ?? null);
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === 'k' &&
        snapshot &&
        !editor &&
        !settings &&
        !deleting &&
        !contentDirty
      ) {
        e.preventDefault();
        setPage('today');
        setSelected(null);
        setEditor({ type: 'actual', defaults: { date } });
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [snapshot, date, editor, settings, deleting, contentDirty]);
  const lastSelected = useRef<{ vaultId: string; entry: Entry } | null>(null);
  let selectedEntry = snapshot?.entries.find((e) => e.data.id === selected);
  if (selectedEntry && snapshot)
    lastSelected.current = { vaultId: snapshot.vaultId, entry: selectedEntry };
  // Keep an unsaved editor mounted if an external deletion or invalid YAML removes its index entry.
  if (
    !selectedEntry &&
    contentDirty &&
    lastSelected.current?.vaultId === snapshot?.vaultId &&
    lastSelected.current?.entry.data.id === selected
  )
    selectedEntry = lastSelected.current.entry;
  const navigate = (id: string) => {
    if (!canLeaveContent()) return;
    setPage(id);
    setSelected(null);
    setSearch('');
  };
  const handleDeleted = async (result: DeleteResult) => {
    if (selected && result.deletedIds.includes(selected)) {
      setSelected(null);
      setContentDirty(false);
    }
    setDeleting(null);
    setDeletion(result);
    await reload();
  };
  const remove = (entry: Entry) => {
    if (entry.data.type === 'project' || entry.data.type === 'workline') {
      setDeleting(entry);
      return;
    }
    run(async () => {
      await handleDeleted(await removeSpace(entry));
    });
  };
  const hasBusinessNavigation =
    (page === 'workspace' || page === 'knowledge' || page === 'today') && Boolean(snapshot);
  return (
    <div
      className={
        'shell ' +
        (selectedEntry ? 'has-detail ' : '') +
        (hasBusinessNavigation ? 'workspace-shell' : '')
      }
    >
      <main className={`main${hasBusinessNavigation ? ' workspace-main' : ''}`}>
        <header className="topbar">
          <span className="app-brand">CHAOS</span>
          <nav className="main-nav" aria-label="主导航">
            {pages.map((p) => (
              <button
                key={p.id}
                aria-current={page === p.id ? 'page' : undefined}
                onClick={() => navigate(p.id)}
              >
                {p.name}
              </button>
            ))}
          </nav>
          <label className="search">
            <MagnifyingGlassIcon />
            <input
              aria-label="搜索工作"
              placeholder="搜索项目、业务线和待办…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <Button
            className="icon"
            aria-label="重新加载 Vault"
            aria-busy={syncing}
            disabled={!snapshot || syncing}
            onClick={() => run(reload)}
          >
            <ReloadIcon />
          </Button>
          <Button
            className="backup-trigger"
            onClick={() => {
              if (!canLeaveContent()) return;
              setSelected(null);
              setSettings(true);
            }}
          >
            <GearIcon />
            备份
          </Button>
        </header>
        <div className={`content${hasBusinessNavigation ? ' workspace-page' : ''}`}>
          {snapshot && (
            <div className="message-entry">
              <Button
                aria-label="QQ同步设置"
                onClick={() => {
                  if (canLeaveContent()) setSyncPanel('qq');
                }}
              >
                QQ同步设置
                {pendingMessages > 0 && (
                  <span className="message-badge" aria-hidden="true">
                    {pendingMessages}
                  </span>
                )}
              </Button>
              <Button
                onClick={() => {
                  if (canLeaveContent()) setSyncPanel('wechat');
                }}
              >
                微信同步设置
              </Button>
            </div>
          )}
          <ErrorMessage message={error} />
          {error && <Button onClick={() => setError('')}>收起提示</Button>}
          {loading ? (
            <EmptyState>正在读取本地会话…</EmptyState>
          ) : !snapshot ? (
            <Connect onConnected={(s) => setSnapshot(s)} />
          ) : (
            <>
              {snapshot.issues.length > 0 && (
                <details className="diagnostics">
                  <summary>Vault 有 {snapshot.issues.length} 项诊断</summary>
                  {snapshot.issues.map((issue, i) => (
                    <p key={i}>
                      {issue.path}：{issue.message}
                    </p>
                  ))}
                </details>
              )}
              {page === 'review' && (
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">PERSONAL RESEARCH & LIFE</p>
                    <h1>{pages.find((p) => p.id === page)?.name}</h1>
                  </div>
                  <div className="actions">
                    <Button
                      className="primary"
                      onClick={() =>
                        setEditor({ type: 'review', defaults: { week: weekStart(date) } })
                      }
                    >
                      写周复盘
                    </Button>
                  </div>
                </div>
              )}
              {page === 'today' && (
                <Today
                  key={snapshot.vaultId}
                  snapshot={snapshot}
                  date={date}
                  setDate={setDate}
                  actualEditor={editor?.type === 'actual' && !editor.entry ? editor : undefined}
                  dismissActualEditor={() => setEditor(null)}
                  reload={reload}
                  run={run}
                  goWorkspace={goWorkspace}
                  timeline={
                    <Suspense fallback={<EmptyState>正在加载时间线…</EmptyState>}>
                      <Timeline
                        date={date}
                        snapshot={snapshot}
                        edit={setEditor}
                        reload={reload}
                        run={run}
                        goWorkspace={goWorkspace}
                      />
                    </Suspense>
                  }
                />
              )}
              {page === 'workspace' && (
                <>
                  {deletion && (
                    <div className="deletion-result">
                      <span role="status">已删除 {deletion.deletedIds.length} 项内容</span>
                    </div>
                  )}
                  <WorkspaceBoard
                    snapshot={snapshot}
                    edit={setEditor}
                    select={(id) => {
                      if (id !== selected && !canLeaveContent()) return;
                      setSelected(id);
                    }}
                    reload={reload}
                    run={run}
                    query={query}
                    showArchived={showArchived}
                    onShowArchivedChange={setShowArchived}
                  />
                </>
              )}
              {page === 'knowledge' && (
                <Knowledge
                  snapshot={snapshot}
                  query={query}
                  showArchived={showArchived}
                  onShowArchivedChange={setShowArchived}
                />
              )}
              {page === 'review' && (
                <Review
                  snapshot={snapshot}
                  week={weekStart(date)}
                  setDate={setDate}
                  edit={setEditor}
                  select={(id) => goWorkspace(id)}
                />
              )}
            </>
          )}
        </div>
      </main>
      {snapshot && <QuickEdit snapshot={snapshot} reload={reload} />}
      {snapshot && (
        <SpaceMenu snapshot={snapshot} edit={setEditor} remove={remove} run={run} reload={reload} />
      )}
      {selectedEntry && snapshot && isSpaceItem(selectedEntry.data) && (
        <SpaceDetails
          entry={selectedEntry}
          snapshot={snapshot}
          edit={setEditor}
          close={() => {
            if (canLeaveContent()) setSelected(null);
          }}
          run={run}
          reload={reload}
          onDirtyChange={setContentDirty}
        />
      )}
      {editor &&
        snapshot &&
        (editor.defaults?.comment && editor.entry ? (
          <CommentForm
            key={editor.entry.data.id}
            entry={editor.entry}
            close={() => setEditor(null)}
            reload={reload}
          />
        ) : ['project', 'workline', 'milestone', 'todo'].includes(editor.type) ? (
          <WorkItemForm
            key={editor.entry?.revision ?? JSON.stringify(editor)}
            editor={editor}
            snapshot={snapshot}
            close={() => setEditor(null)}
            reload={reload}
          />
        ) : editor.type === 'actual' ? (
          editor.entry ? (
            <ActualRecordForm
              key={editor.entry?.revision ?? JSON.stringify(editor)}
              editor={editor}
              snapshot={snapshot}
              close={() => setEditor(null)}
              reload={reload}
            />
          ) : null
        ) : (
          <ReviewForm
            key={editor.entry?.revision ?? JSON.stringify(editor)}
            editor={editor}
            close={() => setEditor(null)}
            reload={reload}
          />
        ))}
      {deleting && snapshot && (
        <DeleteSpaceDialog
          key={deleting.data.id}
          entry={deleting}
          draftAffected={
            contentDirty &&
            spaceSubtree(snapshot.entries, deleting.data.id).some((e) => e.data.id === selected)
          }
          close={() => setDeleting(null)}
          deleted={handleDeleted}
        />
      )}
      {syncPanel && snapshot && (
        <Modal
          title={syncPanel === 'qq' ? 'QQ同步设置' : '微信同步设置'}
          wide
          onClose={() => setSyncPanel(null)}
        >
          {syncPanel === 'qq' ? (
            <MessageInbox
              key={snapshot.vaultId}
              snapshot={snapshot}
              reload={reload}
              onPendingChange={setPendingMessages}
            />
          ) : (
            <WechatSync />
          )}
        </Modal>
      )}
      {settings && (
        <Modal title="Vault 与数据安全" onClose={() => setSettings(false)} wide>
          <Appearance />
          <Connect
            onConnected={(s) => {
              setSnapshot(s);
              setSelected(null);
              setEditor(null);
              setDeleting(null);
              setDeletion(null);
              setSettings(false);
            }}
          />
          {snapshot && <Backup snapshot={snapshot} reload={reload} />}
        </Modal>
      )}
    </div>
  );
}
