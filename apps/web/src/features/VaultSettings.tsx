import { useState, useEffect, useCallback } from 'react';
import type { Snapshot } from '../../../../packages/domain/index';
import { api } from '../api';
import { Button, Field, ErrorMessage } from '../components/ui';
export function Connect({ onConnected }: { onConnected: (snapshot: Snapshot) => void }) {
  const [value, setValue] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <section className="connect">
      <h2>从你的 Obsidian Vault 开始</h2>
      <p>
        填写一个已有文件夹的绝对路径。首次试用请使用复制的示例 Vault。ATLAS 仅创建自己的管理目录。
      </p>
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
        <Field label="Vault 绝对路径">
          <input
            required
            placeholder="E:\\Notes\\MyVault"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <ErrorMessage message={error} />
        <Button disabled={busy} className="primary">
          {busy ? '正在扫描…' : '连接本地 Vault'}
        </Button>
      </form>
      <p className="hint">
        可读 Markdown
        为唯一事实来源。原有笔记不会被批量转换；每次修改前保留备份，外部修改产生冲突时停止保存。
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
        此处备份仅包含 ATLAS 管理的 Markdown；原生附件与普通笔记请另用 Vault
        全量备份。恢复会保留当下版本的撤销备份，不删除备份后新增的记录。
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
      {backups.slice(0, 20).map((b) => (
        <div className="backup-row" key={b.id}>
          <span>
            {new Date(b.createdAt).toLocaleString('zh-CN')} · {b.count} 份记录
          </span>
          <Button
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  `将恢复此备份中的 ${b.count} 份记录（含笔记正文）。当前版本会先备份。继续？`,
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
