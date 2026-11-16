import { useState } from 'react';
import {
  localDay,
  type Snapshot,
  type SpaceItem,
  type Todo,
  type Milestone,
} from '../../../../packages/domain/index';
import { isComplete } from '../../../../packages/domain/workspace';
import { DatePicker } from '../components/ui';
import { complete } from '../api';
import type { Editor } from '../types/editor';
import type { RecordSource } from '../features/actual/types';
import { TodaySidebar } from '../features/today/TodaySidebar';
import { TodayAgenda } from '../features/today/TodayAgenda';
import { TodayCapture } from '../features/today/TodayCapture';
import { ActualRecordList } from '../features/actual/ActualRecordList';
import { actualsForDay } from '../features/actual/selectors';
export function Today({
  snapshot,
  date,
  setDate,
  goWorkspace,
  reload,
  run,
  actualEditor,
  dismissActualEditor,
  editActual,
}: {
  snapshot: Snapshot;
  date: string;
  setDate: (date: string) => void;
  goWorkspace: (id?: string) => void;
  reload: () => Promise<void>;
  run: (fn: () => Promise<unknown>) => void;
  actualEditor?: Editor;
  dismissActualEditor: () => void;
  editActual: (editor: Editor) => void;
}) {
  const [lineId, setLineId] = useState('');
  const [source, setSource] = useState<RecordSource>();
  const [view, setView] = useState<'record' | 'done'>('record');
  const [recentId, setRecentId] = useState('');
  const toggle = (item: SpaceItem) =>
    run(async () => {
      const entry = snapshot.entries.find((e) => e.data.id === item.id)!;
      await complete(entry, !isComplete(item, snapshot.entries));
      await reload();
    });
  const record = (item: Todo | Milestone) =>
    setSource({ id: item.id, type: item.type, request: Date.now() });
  return (
    <div className="today-page">
      <div className="section-heading today-heading">
        <h1>今日</h1>
        <div className="segmented" role="tablist" aria-label="今日记录">
          <button role="tab" aria-selected={view === 'record'} onClick={() => setView('record')}>
            记录
          </button>
          <button role="tab" aria-selected={view === 'done'} onClick={() => setView('done')}>
            已做
          </button>
        </div>
        <div className="today-date-control">
          {date !== localDay() && (
            <button
              onClick={() => {
                setSource(undefined);
                setDate(localDay());
              }}
            >
              回到今天
            </button>
          )}
          <DatePicker
            aria-label="查看日期"
            value={date}
            onChange={(e) => {
              if (e.target.value) {
                setSource(undefined);
                setDate(e.target.value);
              }
            }}
          />
        </div>
      </div>
      {view === 'done' ? (
        <section className="today-done" aria-label="当天实际记录">
          <ActualRecordList
            entries={actualsForDay(snapshot.entries, date)}
            snapshot={snapshot}
            edit={editActual}
            reload={reload}
            recentId={recentId}
          />
          <button className="button primary" onClick={() => setView('record')}>
            继续记录
          </button>
        </section>
      ) : (
        <div className="today-layout">
          <TodaySidebar
            snapshot={snapshot}
            date={date}
            lineId={lineId}
            goWorkspace={goWorkspace}
            editActual={editActual}
            reload={reload}
          />
          <TodayAgenda
            snapshot={snapshot}
            date={date}
            lineId={lineId}
            setLineId={setLineId}
            reload={reload}
            goWorkspace={goWorkspace}
            toggle={toggle}
            record={record}
          />
          <TodayCapture
            snapshot={snapshot}
            date={date}
            source={source}
            editor={actualEditor}
            dismissEditor={dismissActualEditor}
            reload={reload}
            onRecorded={(id, savedDate) => {
              setDate(savedDate);
              setRecentId(id);
              setView('done');
            }}
          />
        </div>
      )}
    </div>
  );
}
