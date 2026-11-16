import { useState } from 'react';
import { isSpaceItem, type Entry, type Snapshot } from '../../../../../packages/domain/index';
import { isComplete } from '../../../../../packages/domain/workspace';
import { complete, promote, save } from '../../api';
import { Button, ErrorMessage, Field } from '../../components/ui';

export function MobileActions({
  entry,
  snapshot,
  close,
  reload,
  remove,
  onBusyChange,
}: {
  onBusyChange: (busy: boolean) => void;
  entry: Entry;
  snapshot: Snapshot;
  close: () => void;
  reload: () => Promise<void>;
  remove: (entry: Entry) => void;
}) {
  const [original] = useState(entry);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [moving, setMoving] = useState(false),
    [targetId, setTarget] = useState('');
  const [placement, setPlacement] = useState<'inside' | 'before' | 'after'>('inside');
  const item = original.data;
  if (!isSpaceItem(item)) return null;
  const pool = item.type === 'milestone' && item.pool;
  const task = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      await fn();
      await reload();
      close();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };
  const targets = snapshot.entries.filter(
    ({ data }) =>
      data.id !== item.id &&
      (placement === 'inside'
        ? (item.type === 'workline' && data.type === 'project') ||
          (item.type === 'milestone' && data.type === 'workline') ||
          (item.type === 'todo' && data.type === 'milestone')
        : (item.type === 'workline' && data.type === 'workline') ||
          (item.type === 'todo' && data.type === 'todo')),
  );
  return (
    <div className="mobile-inline-actions" inert={busy}>
      <ErrorMessage message={error} />
      <fieldset disabled={busy} className="mobile-actions-fields">
        {moving ? (
          <>
            <Field label="移动方式">
              <select
                value={placement}
                onChange={(event) => {
                  setPlacement(event.target.value as typeof placement);
                  setTarget('');
                }}
              >
                <option value="inside">移动到</option>
                {item.type !== 'milestone' && (
                  <>
                    <option value="before">排在前面</option>
                    <option value="after">排在后面</option>
                  </>
                )}
              </select>
            </Field>
            <Field label="目标">
              <select value={targetId} onChange={(event) => setTarget(event.target.value)}>
                <option value="">请选择</option>
                {targets.map(({ data }) => (
                  <option key={data.id} value={data.id}>
                    {'title' in data ? data.title : data.id}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              type="button"
              disabled={!targetId}
              className="primary"
              onClick={() =>
                void task(() =>
                  save(item, original, {
                    move: {
                      targetId,
                      revision: targets.find(({ data }) => data.id === targetId)!.revision,
                      placement,
                    },
                  }),
                )
              }
            >
              确认移动
            </Button>
            <Button type="button" onClick={() => setMoving(false)}>
              返回操作
            </Button>
          </>
        ) : (
          <>
            {!pool && (
              <>
                <Button
                  type="button"
                  onClick={() =>
                    void task(() => complete(original, !isComplete(item, snapshot.entries)))
                  }
                >
                  {isComplete(item, snapshot.entries) ? '重新打开' : '标记完成'}
                </Button>
                {(item.type === 'todo' || item.type === 'milestone') && (
                  <Button type="button" onClick={() => void task(() => promote(original))}>
                    升为业务线
                  </Button>
                )}
                {item.type !== 'project' && (
                  <Button type="button" onClick={() => setMoving(true)}>
                    移动／排序
                  </Button>
                )}
                <Button
                  type="button"
                  className="danger"
                  onClick={() => {
                    remove(original);
                  }}
                >
                  删除
                </Button>
              </>
            )}
          </>
        )}
      </fieldset>
    </div>
  );
}
