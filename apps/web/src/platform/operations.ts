export type OperationProgress = {
  id: string;
  label: string;
  phase: string;
  completed?: number;
  total?: number;
  startedAt: number;
  updatedAt: number;
  cancelable: boolean;
  cancelling: boolean;
};
let current: OperationProgress | null = null;
let controller: AbortController | undefined;
let nativeCancel: ((id: string) => Promise<unknown>) | undefined;
const listeners = new Set<() => void>();
export const operationSnapshot = () => current;
export function subscribeOperation(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function publish(value: OperationProgress | null) {
  current = value;
  for (const listener of listeners) listener();
}
export function operationSignal() {
  return controller?.signal;
}
export function checkOperation() {
  controller?.signal.throwIfAborted();
}
export function reportOperation(phase: string, completed?: number, total?: number) {
  if (current && !current.cancelling)
    publish({ ...current, phase, completed, total, updatedAt: Date.now() });
}
export function nativeOperationProgress(event: {
  taskId: string;
  phase: string;
  completed?: number;
  total?: number;
}) {
  if (current?.id === event.taskId) reportOperation(event.phase, event.completed, event.total);
}
export function installOperationCancel(cancel: (id: string) => Promise<unknown>) {
  nativeCancel = cancel;
}
export async function cancelOperation() {
  if (!current?.cancelable || current.cancelling) return;
  const id = current.id;
  publish({ ...current, cancelling: true, phase: '正在停止操作，请稍候…' });
  controller?.abort(new Error('操作已停止，可以重新尝试。目录如有未完成导入，请重新选择以恢复。'));
  await nativeCancel?.(id);
}
export async function runOperation<T>(
  label: string,
  task: () => Promise<T>,
  cancelable = false,
): Promise<T> {
  if (current) throw new Error('请等待当前操作结束后再试');
  const now = Date.now();
  controller = new AbortController();
  publish({
    id: crypto.randomUUID(),
    label,
    phase: label,
    startedAt: now,
    updatedAt: now,
    cancelable,
    cancelling: false,
  });
  try {
    return await task();
  } finally {
    controller = undefined;
    publish(null);
  }
}
