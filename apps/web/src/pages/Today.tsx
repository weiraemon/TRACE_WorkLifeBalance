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
import { save } from '../api';
import type { Editor } from '../types/editor';
import type { RecordSource } from '../features/actual/types';
import { TodaySidebar } from '../features/today/TodaySidebar';
import { TodayAgenda } from '../features/today/TodayAgenda';
import { TodayCapture } from '../features/today/TodayCapture';
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
  const toggle = (item: SpaceItem) =>
    run(async () => {
      await save(
        item,
        snapshot.entries.find((e) => e.data.id === item.id),
        { completion: !isComplete(item, snapshot.entries) },
      );
      await reload();
    });
  const record = (item: Todo | Milestone) =>
    setSource({ id: item.id, type: item.type, request: Date.now() });
  return (
    <div className="today-page">
      <div className="section-heading today-heading">
        <h1>今日</h1>
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
      <div className="today-layout">
        <TodaySidebar
          snapshot={snapshot}
          date={date}
          lineId={lineId}
          goWorkspace={goWorkspace}
          editActual={editActual}
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
        />
      </div>
    </div>
  );
}
