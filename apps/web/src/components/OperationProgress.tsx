import { useEffect, useState, useSyncExternalStore } from 'react';
import { cancelOperation, operationSnapshot, subscribeOperation } from '../platform/operations';
import { Button } from './ui';

export function OperationProgress() {
  const operation = useSyncExternalStore(subscribeOperation, operationSnapshot);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!operation) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [operation?.id]);
  if (!operation) return null;
  const elapsed = Math.max(0, Math.floor((now - operation.startedAt) / 1000));
  const waiting = now - operation.updatedAt > 15000;
  return (
    <section className="operation-progress" aria-label="操作进度" aria-busy="true">
      <strong>{operation.label}</strong>
      <p role="status" aria-live="polite">
        {operation.phase}
      </p>
      <progress
        aria-label="当前阶段进度"
        max={operation.total && operation.total > 0 ? operation.total : undefined}
        value={operation.total && operation.total > 0 ? operation.completed : undefined}
      />
      <p className="hint">
        {operation.completed !== undefined &&
          (operation.total && operation.total > 0
            ? `${operation.completed} / ${operation.total} · `
            : `已处理 ${operation.completed} 项 · `)}
        已用 {elapsed} 秒
      </p>
      {waiting && (
        <p className="hint">
          {operation.cancelable
            ? '当前步骤尚未返回，可停止本次操作后重试。'
            : '正在等待当前步骤返回，完成或超时后会显示结果。请保持应用打开。'}
        </p>
      )}
      {operation.cancelable && (
        <Button
          disabled={operation.cancelling}
          onClick={() => void cancelOperation().catch(() => {})}
        >
          停止本次操作
        </Button>
      )}
    </section>
  );
}
