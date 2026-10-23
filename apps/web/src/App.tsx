import { useCallback, useDeferredValue, useEffect, useState, lazy, Suspense } from 'react';
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
import { localDay, weekStart, isSpaceItem, type Snapshot } from '../../../packages/domain/index';
import { load, session } from './api';
import { Button, Modal, EmptyState, ErrorMessage, DatePicker } from './components/ui';
import { Connect, Backup } from './features/VaultSettings';
import { ReferenceForm } from './features/ReferenceForm';
import type { Editor } from './features/editor';
import { WorkItemForm } from './features/WorkItemForm';
import { ActualRecordForm } from './features/ActualRecordForm';
import { WorkspaceBoard } from './features/WorkspaceBoard';
import { SpaceDetails } from './features/SpaceDetails';
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
        !settings
      ) {
        e.preventDefault();
        setPage('today');
        setSelected(null);
        setEditor({ type: 'actual', defaults: { date } });
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [snapshot, date, editor, settings]);
  const selectedEntry = snapshot?.entries.find((e) => e.data.id === selected);
  const navigate = (id: string) => {
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
          <p>
            工作空间安排计划，
            <br />
            今日记录实际。
            <br />
            <kbd>Ctrl K</kbd> 记录实际
          </p>
          <Button onClick={() => setSettings(true)}>
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
                  <p className="subtitle">
                    {page === 'workspace'
                      ? '项目是面，业务线是线，关键节点是点。'
                      : page === 'today'
                        ? '计划留在工作空间，这里只记录真实发生的事。'
                        : '让线索留在原处，让记录能被找回。'}
                  </p>
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
                    <Button className="primary" onClick={() => setEditor({ type: 'resource' })}>
                      关联资源
                    </Button>
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
                    select={setSelected}
                    reload={reload}
                    run={run}
                    query={query}
                    showArchived={showArchived}
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
          close={() => setSelected(null)}
          run={run}
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
            close={() => setEditor(null)}
            reload={reload}
          />
        ))}
      {settings && (
        <Modal title="Vault 与数据安全" onClose={() => setSettings(false)} wide>
          <Connect
            onConnected={(s) => {
              setSnapshot(s);
              setSelected(null);
              setEditor(null);
              setSettings(false);
            }}
          />
          {snapshot && <Backup snapshot={snapshot} reload={reload} />}
        </Modal>
      )}
    </div>
  );
}
