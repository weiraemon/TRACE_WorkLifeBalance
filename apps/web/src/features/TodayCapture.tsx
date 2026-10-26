import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../../packages/domain/index';
import { save } from '../api';
import { ActualRecordForm } from './ActualRecordForm';
import { QuickCapture } from './QuickCapture';
import type { Editor } from './editor';

export function TodayCapture({
  snapshot,
  date,
  editor,
  dismissEditor,
  reload,
}: {
  snapshot: Snapshot;
  date: string;
  editor?: Editor;
  dismissEditor: () => void;
  reload: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'actual' | 'quick'>('actual');
  const [version, setVersion] = useState(0);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!editor) return;
    setMode('actual');
    const frame = requestAnimationFrame(() => {
      root.current?.scrollIntoView({ block: 'nearest' });
      root.current
        ?.querySelector<HTMLTextAreaElement>('[aria-label="具体事件"]')
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [editor]);
  return (
    <section className="today-capture" aria-label="做了什么" ref={root}>
      <div className="section-heading">
        <h2>做了什么</h2>
        <div className="segmented">
          <button type="button" aria-pressed={mode === 'actual'} onClick={() => setMode('actual')}>
            实际工作
          </button>
          <button type="button" aria-pressed={mode === 'quick'} onClick={() => setMode('quick')}>
            TODO / IDEA
          </button>
        </div>
      </div>
      <div hidden={mode !== 'actual'}>
        <ActualRecordForm
          key={`${date}:${version}:${JSON.stringify(editor ?? {})}`}
          embedded
          editor={editor ?? { type: 'actual', defaults: { date } }}
          snapshot={snapshot}
          reload={reload}
          close={() => {
            setVersion((v) => v + 1);
            dismissEditor();
          }}
        />
      </div>
      <div hidden={mode !== 'quick'}>
        <QuickCapture
          snapshot={snapshot}
          onCreate={async (item, comment) => {
            await save(item, undefined, {
              comments: comment.trim()
                ? [{ id: crypto.randomUUID(), targetId: item.id, text: comment }]
                : [],
            });
            await reload();
          }}
        />
      </div>
    </section>
  );
}
