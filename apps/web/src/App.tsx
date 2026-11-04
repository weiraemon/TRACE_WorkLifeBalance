import { useCallback, useDeferredValue, useEffect, useState, useRef, lazy, Suspense } from 'react';
import {
  MagnifyingGlassIcon,
  GearIcon,
  ReloadIcon,
  ChatBubbleIcon,
  Pencil2Icon,
} from '@radix-ui/react-icons';
import {
  localDay,
  isSpaceItem,
  type Entry,
  type Snapshot,
  type DeleteResult,
} from '../../../packages/domain/index';
import { draftsAreDurable } from './features/drafts/useDraftState';
import { api, load, session, removeSpace } from './api';
import { spaceSubtree } from '../../../packages/domain/workspace';
import { Button, Modal, EmptyState, ErrorMessage } from './components/ui';
import { Connect, Backup, Appearance } from './features/settings/VaultSettings';
import { Exchange } from './features/settings/Exchange';
import { OperationProgress } from './components/OperationProgress';
import type { Editor } from './types/editor';
import { WorkItemForm } from './features/workspace/WorkItemForm';
import { ActualRecordForm } from './features/actual/ActualRecordForm';
import { CommentForm } from './features/workspace/CommentForm';
import { Workspace } from './pages/Workspace';
import { SpaceMenu } from './features/workspace/SpaceMenu';
import { QuickEdit } from './features/workspace/QuickEdit';
import { SpaceDetails } from './features/workspace/SpaceDetails';
import { DeleteSpaceDialog } from './features/workspace/DeleteSpaceDialog';
import { Knowledge } from './pages/Knowledge';
import { Review } from './pages/Review';
import { Today } from './pages/Today';
const MessageInbox = lazy(() =>
  import('./features/sync/MessageInbox').then((module) => ({ default: module.MessageInbox })),
);
const WechatSync = lazy(() =>
  import('./features/sync/WechatSync').then((module) => ({ default: module.WechatSync })),
);
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
  const [defaultPath, setDefaultPath] = useState('');
  const [page, setPage] = useState('today'),
    [selected, setSelected] = useState<string | null>(null),
    [editor, setEditor] = useState<Editor | null>(null),
    [settings, setSettings] = useState(false);
  const [search, setSearch] = useState(''),
    [date, setDate] = useState(localDay()),
    [reviewDate, setReviewDate] = useState(localDay()),
    [showArchived, setShowArchived] = useState(false);
  const query = useDeferredValue(search.toLowerCase());
  const [contentDirty, setContentDirty] = useState(false);
  const [syncPanel, setSyncPanel] = useState<'qq' | 'wechat' | null>(null);
  const [pendingPanel, setPendingPanel] = useState(false);
  const [pendingTab, setPendingTab] = useState<'qq' | 'wechat'>('qq');
  const [pendingCount, setPendingCount] = useState(0);
  const [pastePanel, setPastePanel] = useState(false);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [deletion, setDeletion] = useState<DeleteResult | null>(null);
  const canLeaveContent = () =>
    !contentDirty || draftsAreDurable() || window.confirm('正文尚未保存，确定放弃并离开？');
  const snapshotRequest = useRef(0);
  const acceptConnection = useCallback((next: Snapshot) => {
    snapshotRequest.current++;
    setSnapshot(next);
    setSyncing(false);
  }, []);
  const reload = useCallback(async () => {
    const request = ++snapshotRequest.current;
    setSyncing(true);
    try {
      const [next, inbox] = await Promise.all([
        load(),
        api<{ state: { candidates: unknown[] } }>('messages').catch(() => null),
      ]);
      if (request === snapshotRequest.current) {
        setSnapshot(next);
        if (inbox) setPendingCount(inbox.state.candidates.length);
      }
    } catch (error) {
      if (request === snapshotRequest.current) throw error;
    } finally {
      if (request === snapshotRequest.current) setSyncing(false);
    }
  }, []);
  const run = useCallback((fn: () => Promise<unknown>) => {
    setError('');
    void fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    void session()
      .then(async (s) => {
        setDefaultPath(s.root);
        if (s.connectionError) setError(s.connectionError);
        if (s.connected) await reload();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [reload]);
  useEffect(() => {
    if (!snapshot) return;
    let pending = false;
    let previousDay = localDay();
    const synchronize = () => {
      const today = localDay();
      if (today !== previousDay) {
        const yesterday = previousDay;
        setDate((selectedDate) => (selectedDate === yesterday ? today : selectedDate));
        previousDay = today;
      }
      if (document.hidden || pending) return;
      pending = true;
      void reload()
        .catch((e) => setError(String(e)))
        .finally(() => {
          pending = false;
        });
    };
    const timer = setInterval(synchronize, 5000);
    window.addEventListener('focus', synchronize);
    document.addEventListener('visibilitychange', synchronize);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', synchronize);
      document.removeEventListener('visibilitychange', synchronize);
    };
  }, [Boolean(snapshot), reload]);
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
        setDate(localDay());
        setEditor({ type: 'actual', defaults: { date: localDay() } });
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
    if (id === 'today' && page !== 'today') setDate(localDay());
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
  const hasBusinessNavigation = (page === 'workspace' || page === 'knowledge') && Boolean(snapshot);
  return (
    <div
      className={
        'shell ' +
        (selectedEntry ? 'has-detail ' : '') +
        (hasBusinessNavigation ? 'workspace-shell' : '')
      }
    >
      <main
        className={`main${hasBusinessNavigation ? ' workspace-main' : ''}${page === 'today' && snapshot ? ' today-main' : ''}`}
      >
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
          <div className="topbar-actions">
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
              className="pending-trigger"
              aria-label={pendingCount ? `待确认，${pendingCount} 条` : '待确认'}
              disabled={!snapshot}
              onClick={() => {
                if (!canLeaveContent()) return;
                setSelected(null);
                setPendingPanel(true);
              }}
            >
              <ChatBubbleIcon />
              <span className="topbar-action-label">待确认</span>
              {pendingCount > 0 && (
                <span className="pending-count">{pendingCount > 99 ? '99+' : pendingCount}</span>
              )}
            </Button>
            <Button
              className="paste-trigger"
              aria-label="手动粘贴"
              disabled={!snapshot}
              onClick={() => {
                if (!canLeaveContent()) return;
                setSelected(null);
                setPastePanel(true);
              }}
            >
              <Pencil2Icon />
              <span className="topbar-action-label">手动粘贴</span>
            </Button>
            <Button
              className="backup-trigger"
              aria-label="设置"
              onClick={() => {
                if (!canLeaveContent()) return;
                setSelected(null);
                setSettings(true);
              }}
            >
              <GearIcon />
              <span className="topbar-action-label">设置</span>
            </Button>
          </div>
        </header>
        <div
          className={`content${hasBusinessNavigation ? ' workspace-page' : ''}${page === 'today' && snapshot ? ' today-content' : ''}`}
        >
          <ErrorMessage message={error} />
          {error && <Button onClick={() => setError('')}>收起提示</Button>}
          {loading ? (
            <EmptyState>正在读取本地会话…</EmptyState>
          ) : !snapshot ? (
            <Connect
              defaultPath={defaultPath}
              onConnected={(s) => {
                acceptConnection(s);
                setError('');
              }}
            />
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
                  editActual={setEditor}
                />
              )}
              {page === 'workspace' && (
                <>
                  {deletion && (
                    <div className="deletion-result">
                      <span role="status">已删除 {deletion.deletedIds.length} 项内容</span>
                    </div>
                  )}
                  <Workspace
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
                  date={reviewDate}
                  setDate={setReviewDate}
                  edit={setEditor}
                  reload={reload}
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
            draftScope={snapshot.root}
            key={editor.entry.data.id}
            entry={editor.entry}
            close={() => setEditor((current) => (current === editor ? null : current))}
            reload={reload}
          />
        ) : ['project', 'workline', 'milestone', 'todo'].includes(editor.type) ? (
          <WorkItemForm
            key={editor.entry?.revision ?? JSON.stringify(editor)}
            editor={editor}
            snapshot={snapshot}
            close={() => setEditor((current) => (current === editor ? null : current))}
            reload={reload}
          />
        ) : editor.type === 'actual' ? (
          editor.entry ? (
            <ActualRecordForm
              key={editor.entry?.revision ?? JSON.stringify(editor)}
              editor={editor}
              snapshot={snapshot}
              close={() => setEditor((current) => (current === editor ? null : current))}
              reload={reload}
            />
          ) : null
        ) : null)}
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
          className="sync-dialog"
          onClose={() => setSyncPanel(null)}
        >
          <div className="dialog-body">
            <Suspense fallback={<EmptyState>正在加载消息设置…</EmptyState>}>
              {syncPanel === 'qq' ? (
                <MessageInbox
                  key={snapshot.vaultId}
                  snapshot={snapshot}
                  reload={reload}
                  onPendingChange={setPendingCount}
                  mode="settings"
                />
              ) : (
                <WechatSync snapshot={snapshot} reload={reload} onPendingChange={setPendingCount} mode="settings" />
              )}
            </Suspense>
          </div>
        </Modal>
      )}
      {pendingPanel && snapshot && (
        <Modal title="待确认" wide className="sync-dialog" onClose={() => setPendingPanel(false)}>
          <div className="dialog-body">
            <div className="segmented message-source-tabs">
              <button aria-pressed={pendingTab === 'qq'} onClick={() => setPendingTab('qq')}>
                QQ消息
              </button>
              <button
                aria-pressed={pendingTab === 'wechat'}
                onClick={() => setPendingTab('wechat')}
              >
                微信消息
              </button>
            </div>
            <Suspense fallback={<EmptyState>正在加载待确认消息…</EmptyState>}>
              {pendingTab === 'qq' ? (
                <MessageInbox
                  key={`${snapshot.vaultId}-pending`}
                  snapshot={snapshot}
                  reload={reload}
                  onPendingChange={setPendingCount}
                  mode="pending"
                />
              ) : (
                <WechatSync snapshot={snapshot} reload={reload} onPendingChange={setPendingCount} mode="pending" />
              )}
            </Suspense>
          </div>
        </Modal>
      )}
      {pastePanel && snapshot && (
        <Modal
          title="手动粘贴消息"
          wide
          className="sync-dialog"
          onClose={() => setPastePanel(false)}
        >
          <div className="dialog-body">
            <Suspense fallback={<EmptyState>正在加载粘贴面板…</EmptyState>}>
              <MessageInbox
                key={`${snapshot.vaultId}-paste`}
                snapshot={snapshot}
                reload={reload}
                onPendingChange={setPendingCount}
                mode="paste"
              />
            </Suspense>
          </div>
        </Modal>
      )}
      {settings && (
        <Modal title="设置" onClose={() => setSettings(false)} wide>
          <OperationProgress />
          <Appearance />
          <Connect
            defaultPath={snapshot?.root ?? defaultPath}
            onConnected={(s) => {
              acceptConnection(s);
              setError('');
              setSelected(null);
              setEditor(null);
              setDeleting(null);
              setDeletion(null);
              setSettings(false);
            }}
          />
          {snapshot && (
            <>
              <section className="sync-entry" aria-label="外部消息接入">
                <h3>外部消息接入</h3>
                <div className="actions">
                  {(['qq', 'wechat'] as const).map((kind) => (
                    <Button
                      key={kind}
                      onClick={() => {
                        if (!canLeaveContent()) return;
                        setSettings(false);
                        setSyncPanel(kind);
                      }}
                    >
                      {kind === 'qq' ? 'QQ同步设置' : '微信同步设置'}
                    </Button>
                  ))}
                </div>
              </section>
              <Backup snapshot={snapshot} reload={reload} />
              <Exchange key={snapshot.vaultId} snapshot={snapshot} reload={reload} />
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
