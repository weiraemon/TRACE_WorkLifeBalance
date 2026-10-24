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
        可读 Markdown 为唯一事实来源。原有笔记不会被批量转换，外部修改产生冲突时停止保存。
      </p>
    </section>
  );
}

export function Backup({ snapshot, reload }: { snapshot: Snapshot; reload: () => Promise<void> }) {
  const [backups, setBackups] = useState<
      {
        id: string;
        createdAt: string;
        count: number;
        kind: 'manual' | 'delete' | 'restore' | 'recovery';
      }[]
    >([]),
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
        普通保存不生成快照。手动快照保留 3 份、删除撤销保留最近 1 次、恢复前备份保留 1 份。
        快照仅包含 ATLAS 管理的 Markdown，附件与普通笔记请另行备份。
      </p>
      {backups.some((b) => b.kind === 'recovery') && (
        <p className="error">存在删除中断的恢复备份，已保留，请检查后恢复。</p>
      )}
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
      <Button
        disabled={busy}
        onClick={() => {
          if (
            !window.confirm(
              '将清理超出保留数量的快照、重复回收文件和旧版普通笔记备份。清理后这些历史无法恢复，当前 Markdown 文件保持原样。继续？',
            )
          )
            return;
          void task(async () => {
            const result = await api<{ removed: number }>('cleanup-backups', {});
            setMessage(`已清理 ${result.removed} 份历史文件`);
          });
        }}
      >
        清理旧备份
      </Button>
      <p role="status">{message}</p>
      <ErrorMessage message={error} />
      {backups.map((b) => (
        <div className="backup-row" key={b.id}>
          <span>
            {
              {
                manual: '手动快照',
                delete: '最近删除',
                restore: '恢复前备份',
                recovery: '中断恢复',
              }[b.kind]
            }{' '}
            · {new Date(b.createdAt).toLocaleString('zh-CN')} · {b.count} 份记录
          </span>
          <Button
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  `将恢复此备份中的 ${b.count} 份记录（含笔记正文）。被替换的当前内容将合并保留一份恢复前备份。继续？`,
                )
              )
                return;
              void task(async () => {
                const result = await api<{ restored: number; warning?: string }>('restore', {
                  id: b.id,
                  expectations: Object.fromEntries(
                    snapshot.entries.map((e) => [e.data.id, e.revision]),
                  ),
                });
                setMessage(`已恢复 ${result.restored} 份记录`);
                if (result.warning) setError(result.warning);
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
