import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  Pencil2Icon,
  CheckIcon,
  ListBulletIcon,
  LayersIcon,
  BarChartIcon,
  ReaderIcon,
  GearIcon,
  ArrowLeftIcon,
  ReloadIcon,
  PlusIcon,
  MagnifyingGlassIcon,
} from '@radix-ui/react-icons';
import {
  isSpaceItem,
  localDay,
  timeTotals,
  type Entry,
  type BusinessLine,
  type Snapshot,
} from '../../../../../packages/domain/index';
import { contactsForDay, isComplete, lineFor } from '../../../../../packages/domain/workspace';
import { api, complete, load, removeSpace, save, session } from '../../api';
import { androidRequest, isAndroid } from '../../platform/android';
import { Button, DatePicker, EmptyState, ErrorMessage, Modal } from '../../components/ui';
import { Appearance, Backup, Connect } from '../settings/VaultSettings';
import { Exchange } from '../settings/Exchange';
import { TodayAgenda } from '../today/TodayAgenda';
import { ActualRecordList } from '../actual/ActualRecordList';
import { ActualRecordForm } from '../actual/ActualRecordForm';
import { QuickCapture } from '../capture/QuickCapture';
import { WorkItemForm } from '../workspace/WorkItemForm';
import { CommentForm } from '../workspace/CommentForm';
import { DeleteSpaceDialog } from '../workspace/DeleteSpaceDialog';
import { SpaceDetails } from '../workspace/SpaceDetails';
import { workspaceGroups } from '../workspace/workspaceGroups';
import type { Editor } from '../../types/editor';
import type { RecordSource } from '../actual/types';
import { draftsAreDurable } from '../drafts/useDraftState';
import { ProjectList } from './ProjectList';
import { VerticalLine } from './VerticalLine';
import { MobileActions } from './MobileActions';
import { MobileNotes } from './MobileNotes';
import './mobile.css';
import { OperationProgress } from '../../components/OperationProgress';
import { operationSnapshot, runOperation } from '../../platform/operations';

const Review = lazy(() =>
  import('../../pages/Review').then((module) => ({ default: module.Review })),
);
const destinations = [
  { id: 'edit', label: '编辑', title: '编辑', icon: Pencil2Icon },
  { id: 'done', label: '已做', title: '今日已做', icon: CheckIcon },
  { id: 'today', label: '待做', title: '今日待做／待联系', icon: ListBulletIcon },
  { id: 'workspace', label: '空间', title: '工作空间', icon: LayersIcon },
  { id: 'review', label: '回顾', title: '回顾', icon: BarChartIcon },
  { id: 'notes', label: '笔记', title: '笔记', icon: ReaderIcon },
] as const;
type Page = (typeof destinations)[number]['id'];
type Route = { page: Page; lineId: string };

export default function MobileApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [loading, setLoading] = useState(true),
    [syncing, setSyncing] = useState(false),
    [error, setError] = useState('');
  const [route, setRoute] = useState<Route>({ page: 'today', lineId: '' });
  const [date, setDate] = useState(localDay()),
    [reviewDate, setReviewDate] = useState(localDay());
  const [settings, setSettings] = useState(false),
    [query, setQuery] = useState(''),
    [archived, setArchived] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [actionId, setActionId] = useState<string | null>(null),
    [deleting, setDeleting] = useState<Entry | null>(null);
  const [editMode, setEditMode] = useState<'actual' | 'todo'>('actual'),
    [formVersion, setFormVersion] = useState(0),
    [source, setSource] = useState<RecordSource>();
  const dirty = useRef(new Set<string>()),
    request = useRef(0),
    main = useRef<HTMLElement>(null);
  const [isDirty, setIsDirty] = useState(false);
  const previousLine = useRef<{ vaultId: string; line: BusinessLine } | null>(null);
  const previousDetail = useRef<{ vaultId: string; entry: Entry } | null>(null);
  const markDirty = useCallback((key: string, value: boolean) => {
    if (value) dirty.current.add(key);
    else dirty.current.delete(key);
    setIsDirty(Boolean(dirty.current.size));
  }, []);
  const notesDirty = useCallback((value: boolean) => markDirty('notes', value), [markDirty]);
  const actualDirty = useCallback((value: boolean) => markDirty('actual', value), [markDirty]);
  const workDirty = useCallback((value: boolean) => markDirty('work', value), [markDirty]);
  const detailDirty = useCallback((value: boolean) => markDirty('detail', value), [markDirty]);
  const accept = useCallback((next: Snapshot) => {
    request.current++;
    setSnapshot(next);
    setSyncing(false);
    setError('');
  }, []);
  const reload = useCallback(async () => {
    const sequence = ++request.current;
    setSyncing(true);
    try {
      const next = await load();
      if (sequence === request.current) setSnapshot(next);
    } catch (error) {
      if (sequence === request.current) throw error;
    } finally {
      if (sequence === request.current) setSyncing(false);
    }
  }, []);
  const run = useCallback((task: () => Promise<unknown>) => {
    setError('');
    void task().catch((error) => setError(error instanceof Error ? error.message : String(error)));
  }, []);
  const canLeave = () => {
    if (
      dirty.current.size > 0 &&
      !draftsAreDurable() &&
      !window.confirm('本机草稿无法保存，确定放弃当前输入并离开？')
    )
      return false;
    dirty.current.delete('notes');
    dirty.current.delete('detail');
    setIsDirty(Boolean(dirty.current.size));
    return true;
  };
  const navigate = (page: Page, lineId = '', historyEntry = true) => {
    if (!canLeave()) return;
    const next = { page, lineId };
    if (historyEntry) history.pushState({ chaosMobile: next }, '');
    setRoute(next);
    setSelected(null);
    setActionId(null);
    setQuery('');
    main.current?.scrollTo({ top: 0 });
  };
  const openEditor = (next: Editor) => {
    if (canLeave()) {
      setSelected(null);
      setEditor(next);
    }
  };
  const showWork = (id: string) => {
    if (!snapshot) return;
    const entry = snapshot.entries.find((entry) => entry.data.id === id);
    if (!entry || !isSpaceItem(entry.data)) return;
    const line = lineFor(entry.data, snapshot.entries);
    navigate('workspace', line?.id ?? '');
    setSelected(id);
  };
  const toggle = (id: string) =>
    run(async () => {
      const entry = snapshot?.entries.find((entry) => entry.data.id === id);
      if (!entry || !isSpaceItem(entry.data)) return;
      await complete(entry, !isComplete(entry.data, snapshot!.entries));
      await reload();
    });
  const remove = (entry: Entry) => {
    if (entry.data.type === 'project' || entry.data.type === 'workline') setDeleting(entry);
    else
      run(async () => {
        await removeSpace(entry);
        setSelected(null);
        await reload();
      });
  };
  const readDirectory = useCallback(() => {
    setLoading(true);
    setError('');
    void runOperation(
      '正在读取工作目录',
      async () => {
        const value = await session();
        if (value.connectionError) setError(value.connectionError);
        if (value.snapshot) accept(value.snapshot);
        else if (value.connected) await reload();
      },
      true,
    )
      .catch((error) => setError(String(error)))
      .finally(() => setLoading(false));
  }, [accept, reload]);
  useEffect(() => {
    document.documentElement.dataset.surface = 'android';
    history.replaceState({ chaosMobile: { page: 'today', lineId: '' } }, '');
    readDirectory();
    return () => {
      delete document.documentElement.dataset.surface;
      request.current++;
    };
  }, [readDirectory]);
  useEffect(() => {
    if (!snapshot) return;
    let previousDay = localDay(),
      pending = false;
    const refresh = (read = true) => {
      const today = localDay();
      if (today !== previousDay) {
        const previous = previousDay;
        setDate((date) => (date === previous ? today : date));
        previousDay = today;
      }
      if (!read || document.hidden || pending || operationSnapshot()) return;
      pending = true;
      void reload()
        .catch((error) => setError(String(error)))
        .finally(() => {
          pending = false;
        });
    };
    const activate = () => refresh();
    const timer = setInterval(() => refresh(!isAndroid()), 5000);
    if (!isAndroid()) window.addEventListener('focus', activate);
    document.addEventListener('visibilitychange', activate);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', activate);
      document.removeEventListener('visibilitychange', activate);
    };
  }, [Boolean(snapshot), reload]);
  const back = () => {
    if (actionId) {
      setActionId(null);
      return;
    }
    if (deleting) {
      setDeleting(null);
      return;
    }
    if (editor) {
      if (canLeave()) setEditor((current) => (current === editor ? null : current));
      return;
    }
    if (selected) {
      if (canLeave()) setSelected(null);
      return;
    }
    if (settings) {
      setSettings(false);
      return;
    }
    if (route.lineId) navigate(route.page);
    else if (route.page !== 'today') navigate('today');
    else if (isAndroid()) void androidRequest('background');
  };
  useEffect(() => {
    const pop = (event: PopStateEvent) => {
      if (canLeave()) setRoute(event.state?.chaosMobile ?? { page: 'today', lineId: '' });
      else history.pushState({ chaosMobile: route }, '');
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty.current.size) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('chaos-back', back);
    window.addEventListener('popstate', pop);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('chaos-back', back);
      window.removeEventListener('popstate', pop);
      window.removeEventListener('beforeunload', unload);
    };
  });
  const groups = snapshot ? workspaceGroups(snapshot.entries, archived, '') : [];
  const lines = groups.flatMap((group) => group.lines);
  const contacts = snapshot ? contactsForDay(snapshot.entries, date) : [];
  let line = lines.find((line) => line.id === route.lineId);
  if (line && snapshot) previousLine.current = { vaultId: snapshot.vaultId, line };
  if (
    !line &&
    dirty.current.has('notes') &&
    previousLine.current?.vaultId === snapshot?.vaultId &&
    previousLine.current?.line.id === route.lineId
  )
    line = previousLine.current.line;
  let selectedEntry = snapshot?.entries.find((entry) => entry.data.id === selected);
  if (selectedEntry && snapshot)
    previousDetail.current = { vaultId: snapshot.vaultId, entry: selectedEntry };
  if (
    !selectedEntry &&
    dirty.current.has('detail') &&
    previousDetail.current?.vaultId === snapshot?.vaultId &&
    previousDetail.current?.entry.data.id === selected
  )
    selectedEntry = previousDetail.current.entry;
  const actionEntry = snapshot?.entries.find((entry) => entry.data.id === actionId);
  const title = destinations.find((item) => item.id === route.page)!.title;
  const updateDate = (next: string) => {
    if (next && canLeave()) {
      setDate(next);
      setFormVersion((version) => version + 1);
    }
  };
  const newActual = (nextSource?: RecordSource) => {
    if (!canLeave()) return;
    setEditMode('actual');
    setSource(nextSource);
    setFormVersion((version) => version + 1);
    navigate('edit');
  };
  const connection = isAndroid() ? (
    <section className="mobile-connect">
      <h2>工作目录</h2>
      <Button
        className="primary"
        onClick={() =>
          run(() =>
            runOperation(
              '正在连接工作目录',
              async () => {
                accept(await api<Snapshot>('connect', {}));
                setSettings(false);
              },
              true,
            ),
          )
        }
      >
        选择文件夹
      </Button>
    </section>
  ) : (
    <Connect
      defaultPath={snapshot?.root}
      onConnected={(next) => {
        accept(next);
        setSettings(false);
      }}
    />
  );
  return (
    <div className="mobile-app">
      <header className="mobile-topbar">
        <div>
          {route.lineId || route.page !== 'today' ? (
            <Button aria-label="返回" onClick={back}>
              <ArrowLeftIcon />
            </Button>
          ) : (
            <span className="mobile-brand">CHAOS</span>
          )}
          <span>{title}</span>
        </div>
        <Button
          aria-label="设置"
          onClick={() => {
            if (canLeave()) setSettings(true);
          }}
        >
          <GearIcon />
        </Button>
      </header>
      <main className="mobile-main" ref={main}>
        {!settings && !loading && <OperationProgress />}
        <ErrorMessage message={error} />
        {error && <Button onClick={() => setError('')}>收起提示</Button>}
        {error && !snapshot && !loading && <Button onClick={readDirectory}>重新读取原目录</Button>}
        {loading ? (
          <div className="mobile-loading">
            <OperationProgress />
          </div>
        ) : !snapshot ? (
          connection
        ) : (
          <>
            {snapshot.issues.length > 0 && (
              <details className="diagnostics">
                <summary>工作目录有 {snapshot.issues.length} 项诊断</summary>
                {snapshot.issues.map((issue, index) => (
                  <p key={index}>
                    {issue.path}：{issue.message}
                  </p>
                ))}
              </details>
            )}
            {(route.page === 'today' || route.page === 'done' || route.page === 'edit') && (
              <div className="mobile-day">
                <span>
                  {date === localDay() ? '今天' : '查看日期'}
                  {isDirty && <small> · 未保存</small>}
                </span>
                <DatePicker
                  aria-label="查看日期"
                  value={date}
                  onChange={(event) => updateDate(event.target.value)}
                />
              </div>
            )}
            {route.page === 'today' && (
              <>
                <TodayAgenda
                  snapshot={snapshot}
                  date={date}
                  lineId=""
                  setLineId={() => {}}
                  reload={reload}
                  goWorkspace={showWork}
                  toggle={(item) => toggle(item.id)}
                  record={(item) =>
                    newActual({ id: item.id, type: item.type, request: Date.now() })
                  }
                />
                <section className="mobile-contacts" aria-label="今天联系谁">
                  <h2>今天联系谁</h2>
                  {contacts
                    .flatMap((group) => group.todos)
                    .map(({ todo, line }) => (
                      <button
                        key={todo.id}
                        className="mobile-contact"
                        onClick={() => showWork(todo.id)}
                      >
                        <strong>
                          {todo.direction === 'from' ? '等' : '找'} {todo.person}
                        </strong>
                        <span>
                          {todo.title}
                          <small>{line.title}</small>
                        </span>
                      </button>
                    ))}
                  {!contacts.length && <p className="hint">没有当天需要联络的事项。</p>}
                </section>
              </>
            )}
            {route.page === 'done' && (
              <section className="mobile-done">
                <p className="mobile-total">
                  {(timeTotals(snapshot.entries, date, date).total / 60).toFixed(1)}
                  <small>小时实际投入</small>
                </p>
                <ActualRecordList
                  entries={snapshot.entries
                    .filter((entry) => entry.data.type === 'actual' && entry.data.date === date)
                    .sort((a, b) =>
                      a.data.type === 'actual' && b.data.type === 'actual'
                        ? a.data.startTime.localeCompare(b.data.startTime)
                        : 0,
                    )}
                  snapshot={snapshot}
                  edit={openEditor}
                  reload={reload}
                />
                {!snapshot.entries.some(
                  (entry) => entry.data.type === 'actual' && entry.data.date === date,
                ) && <EmptyState>还没有记录。记下一段真实做过的工作。</EmptyState>}
                <Button className="mobile-primary-add" onClick={() => newActual()}>
                  <PlusIcon />
                  记一段
                </Button>
              </section>
            )}
            {route.page === 'edit' && (
              <section className="mobile-editor">
                <div
                  className="mobile-edit-modes"
                  data-mode={editMode}
                  role="group"
                  aria-label="录入类型"
                >
                  {(
                    [
                      { id: 'actual', label: '实际工作' },
                      { id: 'todo', label: '待办／节点' },
                    ] as const
                  ).map((mode) => (
                    <button
                      key={mode.id}
                      aria-pressed={editMode === mode.id}
                      onClick={() => {
                        if (canLeave()) {
                          setEditMode(mode.id);
                          setSource(undefined);
                        }
                      }}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
                {editMode === 'actual' ? (
                  <ActualRecordForm
                    key={`actual:${snapshot.vaultId}:${formVersion}`}
                    embedded
                    snapshot={snapshot}
                    editor={{ type: 'actual', defaults: { date } }}
                    source={source}
                    reload={reload}
                    onDirtyChange={actualDirty}
                    close={() => {
                      if (canLeave()) {
                        setFormVersion((version) => version + 1);
                        setSource(undefined);
                      }
                    }}
                  />
                ) : (
                  <div
                    onChangeCapture={() => workDirty(true)}
                    onPasteCapture={() => workDirty(true)}
                    onClickCapture={(event) => {
                      if ((event.target as Element).closest('.importance-picker')) workDirty(true);
                    }}
                  >
                    <QuickCapture
                      key={`capture:${snapshot.vaultId}:${formVersion}`}
                      snapshot={snapshot}
                      today={date}
                      onCreate={async (item, comment) => {
                        await save(item, undefined, {
                          comments: comment.trim()
                            ? [{ id: crypto.randomUUID(), targetId: item.id, text: comment }]
                            : [],
                        });
                        await reload();
                        workDirty(false);
                      }}
                    />
                  </div>
                )}
              </section>
            )}
            {(route.page === 'workspace' || route.page === 'notes') && (
              <>
                {line ? (
                  route.page === 'workspace' ? (
                    <VerticalLine
                      snapshot={snapshot}
                      line={line}
                      lines={lines}
                      changeLine={(id) => navigate('workspace', id)}
                      select={setSelected}
                      edit={openEditor}
                      toggle={toggle}
                      actions={setActionId}
                    />
                  ) : (
                    <MobileNotes
                      key={`${snapshot.vaultId}:${line.id}:${formVersion}`}
                      snapshot={snapshot}
                      line={line}
                      reload={reload}
                      onDirtyChange={notesDirty}
                    />
                  )
                ) : (
                  <>
                    <div className="mobile-project-filter">
                      <div className="mobile-search">
                        <MagnifyingGlassIcon aria-hidden="true" />
                        <input
                          type="search"
                          aria-label="搜索项目和业务线"
                          placeholder="搜索"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                        />
                      </div>
                      <label>
                        <input
                          type="checkbox"
                          checked={archived}
                          onChange={(event) => setArchived(event.target.checked)}
                        />
                        包含已结束
                      </label>
                    </div>
                    <ProjectList
                      snapshot={snapshot}
                      query={query}
                      archived={archived}
                      select={(line) => navigate(route.page, line.id)}
                      edit={openEditor}
                      actions={setActionId}
                    />
                  </>
                )}
              </>
            )}
            {route.page === 'review' && (
              <Suspense fallback={<div className="mobile-loading">正在整理回顾…</div>}>
                <Review
                  snapshot={snapshot}
                  date={reviewDate}
                  setDate={setReviewDate}
                  edit={openEditor}
                  reload={reload}
                />
              </Suspense>
            )}
          </>
        )}
      </main>
      <nav className="mobile-navigation" aria-label="手机导航">
        {destinations.map(({ id, label, title, icon: Icon }) => (
          <button
            key={id}
            aria-label={title}
            aria-current={route.page === id ? 'page' : undefined}
            onClick={() => navigate(id)}
          >
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      {settings && (
        <Modal title="设置" onClose={() => setSettings(false)}>
          <OperationProgress />
          <Appearance />
          {connection}
          {snapshot && (
            <>
              <div className="mobile-settings-actions">
                <Button disabled={syncing} aria-label="重新加载 Vault" onClick={() => run(reload)}>
                  <ReloadIcon />
                  重新加载
                </Button>
                {isAndroid() && (
                  <Button
                    onClick={() =>
                      run(async () => {
                        await api('export', {});
                      })
                    }
                  >
                    导出完整目录
                  </Button>
                )}
              </div>
              <Backup snapshot={snapshot} reload={reload} mobile />
              <Exchange key={snapshot.vaultId} snapshot={snapshot} reload={reload} mobile />
            </>
          )}
        </Modal>
      )}
      {snapshot && actionEntry && (
        <MobileActions
          key={actionEntry.data.id}
          entry={actionEntry}
          snapshot={snapshot}
          close={() => setActionId(null)}
          reload={reload}
          edit={openEditor}
          remove={remove}
        />
      )}
      {snapshot && selectedEntry && (
        <Modal
          title="工作详情"
          onClose={() => {
            if (canLeave()) setSelected(null);
          }}
          className="mobile-detail-dialog"
        >
          <Button className="mobile-detail-more" onClick={() => setActionId(selectedEntry.data.id)}>
            更多操作
          </Button>
          <SpaceDetails
            key={`${selectedEntry.data.id}:${formVersion}`}
            entry={selectedEntry}
            snapshot={snapshot}
            edit={openEditor}
            close={() => {
              if (canLeave()) setSelected(null);
            }}
            run={run}
            reload={reload}
            onDirtyChange={detailDirty}
          />
        </Modal>
      )}
      {snapshot &&
        editor &&
        (editor.defaults?.comment && editor.entry ? (
          <CommentForm
            draftScope={snapshot.root}
            entry={editor.entry}
            close={() => {
              if (canLeave()) setEditor((current) => (current === editor ? null : current));
            }}
            reload={reload}
            onDirtyChange={workDirty}
          />
        ) : editor.type === 'actual' ? (
          <ActualRecordForm
            key={editor.entry?.data.id ?? 'new'}
            editor={editor}
            snapshot={snapshot}
            reload={reload}
            onDirtyChange={actualDirty}
            close={() => {
              if (canLeave()) setEditor((current) => (current === editor ? null : current));
            }}
          />
        ) : (
          <WorkItemForm
            key={editor.entry?.data.id ?? JSON.stringify(editor)}
            editor={editor}
            snapshot={snapshot}
            reload={reload}
            onDirtyChange={workDirty}
            close={() => {
              if (canLeave()) setEditor((current) => (current === editor ? null : current));
            }}
          />
        ))}
      {snapshot && deleting && (
        <DeleteSpaceDialog
          entry={deleting}
          draftAffected={false}
          close={() => setDeleting(null)}
          deleted={async () => {
            setDeleting(null);
            setSelected(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}
