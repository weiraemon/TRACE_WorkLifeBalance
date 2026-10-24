import { useCallback, useDeferredValue, useEffect, useState, useRef, lazy, Suspense } from 'react';
import {
  SunIcon,
  LayersIcon,
  ReaderIcon,
  CounterClockwiseClockIcon,
  PlusIcon,
  MagnifyingGlassIcon,
  GearIcon,
  ReloadIcon,
} from '@radix-ui/react-icons';
import {
  localDay,
  weekStart,
  isSpaceItem,
  type Entry,
  type Snapshot,
  type DeleteResult,
} from '../../../packages/domain/index';
import { load, session } from './api';
import { spaceSubtree } from '../../../packages/domain/workspace';
import { Button, Modal, EmptyState, ErrorMessage, DatePicker } from './components/ui';
import { Connect, Backup } from './features/VaultSettings';
import { ReferenceForm } from './features/ReferenceForm';
import type { Editor } from './features/editor';
import { WorkItemForm } from './features/WorkItemForm';
import { ActualRecordForm } from './features/ActualRecordForm';
import { WorkspaceBoard } from './features/WorkspaceBoard';
import { SpaceDetails } from './features/SpaceDetails';
import { DeleteSpaceDialog } from './features/DeleteSpaceDialog';
import { Knowledge } from './pages/Knowledge';
import { Review } from './pages/Review';
import { Today } from './pages/Today';
const Timeline = lazy(() => import('./features/Timeline').then((m) => ({ default: m.Timeline })));
const pages = [
  { id: 'today', name: '今日', icon: SunIcon },
  { id: 'workspace', name: '工作空间', icon: LayersIcon },
  { id: 'knowledge', name: '知识', icon: ReaderIcon },
  { id: 'review', name: '回顾', icon: CounterClockwiseClockIcon },
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
  return (
    <div className={'shell ' + (selectedEntry ? 'has-detail' : '')}>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate('today');
          }}
        >
          <span className="brand-mark">A</span>
          <span>
            ATLAS<small>科研与生活工作台</small>
          </span>
        </a>
        <nav aria-label="主导航">
          {pages.map((p) => (
            <button
              key={p.id}
              aria-current={page === p.id ? 'page' : undefined}
              onClick={() => navigate(p.id)}
            >
              <p.icon />
              {p.name}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Button
            onClick={() => {
              if (!canLeaveContent()) return;
              setSelected(null);
              setSettings(true);
            }}
          >
            <GearIcon />
            {snapshot ? 'Vault 与备份' : '连接 Vault'}
          </Button>
          {snapshot && (
            <span className="vault-name" title={snapshot.root}>
              {snapshot.root.split(/[\\/]/).pop()} · 本地文件
            </span>
          )}
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <span>{pages.find((p) => p.id === page)?.name}</span>
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
        </header>
        <div className="content">
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
              <div className="page-heading">
                <div>
                  <p className="eyebrow">
                    {page === 'today'
                      ? new Date(date + 'T12:00:00').toLocaleDateString('zh-CN', {
                          month: 'long',
                          day: 'numeric',
                          weekday: 'long',
                        })
                      : 'PERSONAL RESEARCH & LIFE'}
                  </p>
                  <h1>
                    {page === 'today'
                      ? '从这里，继续今天。'
                      : pages.find((p) => p.id === page)?.name}
                  </h1>
                </div>
                <div className="actions">
                  {page === 'today' && (
                    <DatePicker
                      aria-label="查看日期"
                      value={date}
                      onChange={(e) => e.target.value && setDate(e.target.value)}
                    />
                  )}{' '}
                  {page === 'today' && (
                    <Button
                      className="primary"
                      onClick={() => setEditor({ type: 'actual', defaults: { date } })}
                    >
                      <PlusIcon />
                      记录实际
                    </Button>
                  )}
                  {page === 'workspace' && (
                    <Button className="primary" onClick={() => setEditor({ type: 'project' })}>
                      <PlusIcon />
                      新增项目
                    </Button>
                  )}
                  {page === 'knowledge' && (
                    <Button
                      className="primary"
                      onClick={() =>
                        setEditor({ type: 'resource', defaults: { createMarkdown: true } })
                      }
                    >
                      新建笔记
                    </Button>
                  )}
                  {page === 'knowledge' && (
                    <Button onClick={() => setEditor({ type: 'resource' })}>关联资源</Button>
                  )}
                  {page === 'review' && (
                    <Button
                      className="primary"
                      onClick={() =>
                        setEditor({ type: 'review', defaults: { week: weekStart(date) } })
                      }
                    >
                      写周复盘
                    </Button>
                  )}
                </div>
              </div>
              {page === 'today' && (
                <Today
                  snapshot={snapshot}
                  date={date}
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
                  <div className="list-tools">
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={showArchived}
                        onChange={(e) => setShowArchived(e.target.checked)}
                      />
                      含完成 / 归档
                    </label>
                  </div>
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
                    requestDelete={setDeleting}
                  />
                </>
              )}
              {page === 'knowledge' && <Knowledge snapshot={snapshot} edit={setEditor} run={run} />}
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
        (['project', 'workline', 'milestone', 'todo'].includes(editor.type) ? (
          <WorkItemForm
            key={editor.entry?.revision ?? JSON.stringify(editor)}
            editor={editor}
            snapshot={snapshot}
            close={() => setEditor(null)}
            reload={reload}
          />
        ) : editor.type === 'actual' ? (
          <ActualRecordForm
            key={editor.entry?.revision ?? JSON.stringify(editor)}
            editor={editor}
            snapshot={snapshot}
            close={() => setEditor(null)}
            reload={reload}
          />
        ) : (
          <ReferenceForm
            key={editor.entry?.revision ?? JSON.stringify(editor)}
            editor={editor}
            snapshot={snapshot}
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
          deleted={async (result) => {
            if (selected && result.deletedIds.includes(selected)) {
              setSelected(null);
              setContentDirty(false);
            }
            setDeleting(null);
            setDeletion(result);
            try {
              await reload();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        />
      )}
      {settings && (
        <Modal title="Vault 与数据安全" onClose={() => setSettings(false)} wide>
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
