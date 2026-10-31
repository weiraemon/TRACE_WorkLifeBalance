import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../../../packages/domain/index';
import { ActualRecordForm } from '../actual/ActualRecordForm';
import { QuickCapture } from '../capture/QuickCapture';
import { save } from '../../api';
import { SlidingTabs } from '../../components/SlidingTabs';
import type { Editor } from '../../types/editor';
import type { RecordSource } from '../actual/types';

export function TodayCapture({
  snapshot,
  date,
  editor,
  dismissEditor,
  reload,
  source,
}: {
  snapshot: Snapshot;
  date: string;
  editor?: Editor;
  dismissEditor: () => void;
  reload: () => Promise<void>;
  source?: RecordSource;
}) {
  const [mode, setMode] = useState(0);
  const [version, setVersion] = useState(0);
  const [ignoredSource, setIgnoredSource] = useState<number>();
  const root = useRef<HTMLElement>(null);
  const actualPanel = useRef<HTMLDivElement>(null);
  const quickPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editor && !source) return;
    setMode(0);
    const frame = requestAnimationFrame(() => {
      actualPanel.current?.scrollTo({ top: 0 });
      root.current
        ?.querySelector<HTMLTextAreaElement>('[aria-label="具体事件"]')
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [editor, source]);
  return (
    <section className="today-capture" aria-label="做了什么" ref={root}>
      <SlidingTabs
        label="新增内容"
        value={mode}
        onChange={setMode}
        items={[
          {
            label: '今日已做',
            panelRef: actualPanel,
            content: (
              <ActualRecordForm
                key={`${date}:${version}:${JSON.stringify(editor ?? {})}`}
                embedded
                source={source?.request === ignoredSource ? undefined : source}
                editor={editor ?? { type: 'actual', defaults: { date } }}
                snapshot={snapshot}
                reload={reload}
                close={() => {
                  setIgnoredSource(source?.request);
                  setVersion((v) => v + 1);
                  dismissEditor();
                }}
              />
            ),
          },
          {
            label: '待办 / 节点',
            panelRef: quickPanel,
            content: (
              <QuickCapture
                key={date}
                snapshot={snapshot}
                today={date}
                onCreate={async (item, comment) => {
                  await save(item, undefined, {
                    comments: comment.trim()
                      ? [{ id: crypto.randomUUID(), targetId: item.id, text: comment }]
                      : [],
                  });
                  await reload();
                  quickPanel.current?.scrollTo({ top: 0 });
                }}
              />
            ),
          },
        ]}
      />
    </section>
  );
}
