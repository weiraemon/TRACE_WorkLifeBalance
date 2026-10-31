import { useState, useEffect, useCallback } from 'react';
import type { Snapshot } from '../../../../../packages/domain/index';
import { api } from '../../api';
import { Button, Field, ErrorMessage } from '../../components/ui';
import { readTheme, saveTheme } from '../../theme';
export function Appearance() {
  const [theme, setTheme] = useState(readTheme);
  return (
    <section className="appearance" aria-label="主题">
      <h2>外观</h2>
      <div className="segmented">
        {(
          [
            ['sage', '暖绿'],
            ['blue', '静蓝'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={theme === value}
            onClick={() => {
              saveTheme(value);
              setTheme(value);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
export function Connect({
  onConnected,
  defaultPath = '',
}: {
  onConnected: (snapshot: Snapshot) => void;
  defaultPath?: string;
}) {
  const [value, setValue] = useState(defaultPath),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <section className="connect">
      <h2>选择 Markdown 工作目录</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            onConnected(await api<Snapshot>('connect', { path: value }));
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="工作目录绝对路径">
          <input
            required
            placeholder="E:\\Notes\\MyVault"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        {window.chaosDesktop && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              void window
                .chaosDesktop!.chooseDirectory()
                .then((selected) => {
                  if (selected) setValue(selected);
                })
                .catch((error) => setError(String(error)));
            }}
          >
            浏览文件夹…
          </Button>
        )}
        <ErrorMessage message={error} />
        <Button disabled={busy} className="primary">
          {busy ? '正在扫描…' : '连接工作目录'}
        </Button>
      </form>
      <p className="hint">
        可读 Markdown 为唯一事实来源。原有笔记不会被批量转换，外部修改产生冲突时停止保存。
      </p>
    </section>
  );
}

export function Backup({ snapshot, reload }: { snapshot: Snapshot; reload: () => Promise<void> }) {
  const [backups, setBackups] = useState<{ id: string; createdAt: string; count: number }[]>([]),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => setBackups(await api('backups')), []);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, [refresh]);
  const task = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="backup">
      <h2>备份与恢复</h2>
      <p className="hint">
        仅手动创建快照，最多保留 3 份。编辑、删除和恢复不自动生成备份。 快照仅包含 CHAOS 管理的
        Markdown，附件与普通笔记请另行备份。
      </p>
      <Button
        disabled={busy}
        onClick={() =>
          void task(async () => {
            const result = await api<{ count: number }>('backup', {});
            setMessage(`已备份 ${result.count} 份记录到 Vault/.atlas/backups`);
          })
        }
      >
        创建管理数据快照
      </Button>
      <p role="status">{message}</p>
      <ErrorMessage message={error} />
      {backups.map((b) => (
        <div className="backup-row" key={b.id}>
          <span>
            {new Date(b.createdAt).toLocaleString('zh-CN')} · {b.count} 份记录
          </span>
          <Button
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  `将恢复此备份中的 ${b.count} 份记录（含笔记正文）。当前内容会被替换，不会另建恢复前备份。继续？`,
                )
              )
                return;
              void task(async () => {
                const result = await api<{ restored: number }>('restore', {
                  id: b.id,
                  expectations: Object.fromEntries(
                    snapshot.entries.map((e) => [e.data.id, e.revision]),
                  ),
                });
                setMessage(`已恢复 ${result.restored} 份记录`);
              });
            }}
          >
            恢复
          </Button>
        </div>
      ))}
    </section>
  );
}
