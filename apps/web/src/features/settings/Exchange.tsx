import { useState } from 'react';
import { command } from '../../api';
import { Button, ErrorMessage, Field } from '../../components/ui';
import { readExchangeFile, saveExchangeFile } from '../../platform/exchange-file';
import { isAndroid } from '../../platform/android';
import {
  parseExchange,
  type ExchangeBundle,
  type ExchangeDocument,
  type ExchangePreview,
  type ExchangeReceipt,
} from '../../../../../packages/domain/exchange';
import type { Snapshot } from '../../../../../packages/domain/index';
import { WifiExchange } from './WifiExchange';
import { reportOperation, runOperation } from '../../platform/operations';

export function Exchange({
  snapshot,
  reload,
  mobile = false,
}: {
  snapshot: Snapshot;
  reload: () => Promise<void>;
  mobile?: boolean;
}) {
  // Only common-version hashes are cached; Markdown remains the sole business data source.
  const key = 'chaos-exchange-receipt:' + snapshot.root;
  const [baseline, setBaseline] = useState<ExchangeReceipt | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch {
      return null;
    }
  });
  const [input, setInput] = useState(''),
    [output, setOutput] = useState<ExchangeDocument | null>(null);
  const [bundle, setBundle] = useState<ExchangeBundle | null>(null),
    [preview, setPreview] = useState<ExchangePreview | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  function remember(receipt: ExchangeReceipt | null) {
    setBaseline(receipt);
    try {
      if (receipt) localStorage.setItem(key, JSON.stringify(receipt));
      else localStorage.removeItem(key);
    } catch {
      setMessage('本机无法记住共同版本，请保存回执文件，下次发送前重新载入。');
    }
  }
  async function run(task: () => Promise<void>, label = '正在处理交换文件') {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await runOperation(label, task);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function inspect(text: string) {
    setBundle(null);
    setPreview(null);
    setOutput(null);
    const document = await parseExchange(JSON.parse(text));
    if (document.kind === 'receipt') {
      remember(document);
      setMessage('已载入共同版本回执。下次发送只包含与该版本不同的内容。');
    } else {
      reportOperation('正在读取本机目录并检查导入冲突');
      const result = await command<ExchangePreview>({ type: 'exchange.preview', bundle: document });
      setBundle(document);
      setPreview(result);
    }
  }
  const blocked =
    !preview || preview.errors.length > 0 || preview.rows.some((row) => row.status === 'conflict');
  return (
    <section className="exchange" aria-label="设备增量交换">
      <h2>设备增量交换</h2>
      <WifiExchange mobile={mobile} baseline={baseline} remember={remember} reload={reload} />
      <details>
        <summary>离线文件交换</summary>
        {!mobile && (
          <p className="hint">
            通过 USB 或文件传递
            JSON。首次发送全部受管内容；对方导入后，把回执传回来并载入，后续只发变化。也可用同一回执反向发送。删除、附件和普通非受管文件不自动同步。
          </p>
        )}
        <fieldset disabled={busy}>
          <p>{baseline ? '已记住共同版本，可增量发送。' : '尚无共同版本，将首次全量发送。'}</p>
          <div className="actions">
            <Button
              onClick={() =>
                void run(async () => {
                  setOutput(await command<ExchangeBundle>({ type: 'exchange.export', baseline }));
                  setMessage('已生成交换包，请保存并传给另一台设备。生成文件不会推进共同版本。');
                }, '正在生成发送文件')
              }
            >
              生成发送包
            </Button>
            {baseline && (
              <Button
                onClick={() => {
                  remember(null);
                  setOutput(null);
                }}
              >
                清除共同版本
              </Button>
            )}
          </div>
          {isAndroid() ? (
            <Button onClick={() => void run(async () => inspect(await readExchangeFile()))}>
              打开交换文件或回执
            </Button>
          ) : (
            <Field label="打开交换文件或回执">
              <input
                type="file"
                accept=".json,application/json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void run(async () => inspect(await readExchangeFile(file)));
                }}
              />
            </Field>
          )}
          <details>
            <summary>粘贴 JSON</summary>
            <Field label="交换 JSON">
              <textarea
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  setPreview(null);
                  setBundle(null);
                }}
              />
            </Field>
            <Button disabled={!input.trim()} onClick={() => void run(() => inspect(input))}>
              预览粘贴内容
            </Button>
          </details>
          {preview && (
            <div aria-label="交换预览">
              <p>
                新增 {preview.rows.filter((row) => row.status === 'create').length} · 更新{' '}
                {preview.rows.filter((row) => row.status === 'update').length} · 相同{' '}
                {preview.rows.filter((row) => row.status === 'same').length} · 冲突{' '}
                {preview.rows.filter((row) => row.status === 'conflict').length}
              </p>
              {preview.missingIds.length > 0 && (
                <p className="hint">
                  发送端缺少 {preview.missingIds.length}{' '}
                  个旧对象；不会据此删除本机内容，请双方手动核对。
                </p>
              )}
              <ul>
                {preview.rows.map((row) => (
                  <li key={row.id}>
                    {row.title}：{row.reason}
                  </li>
                ))}
              </ul>
              {preview.errors.map((error) => (
                <p key={error} role="alert">
                  {error}
                </p>
              ))}
              <Button
                className="primary"
                disabled={blocked || !bundle}
                onClick={() =>
                  void run(async () => {
                    const result = await command<{
                      receipt: ExchangeReceipt;
                      imported: number;
                      skipped: number;
                    }>({
                      type: 'exchange.apply',
                      bundle: bundle!,
                      revision: preview.revision,
                    });
                    remember(result.receipt);
                    setOutput(result.receipt);
                    setPreview(null);
                    setBundle(null);
                    setMessage(
                      `已导入 ${result.imported} 个对象，跳过 ${result.skipped} 个相同对象。请保存回执并传回发送端。`,
                    );
                    await reload();
                  }, '正在导入交换文件')
                }
              >
                确认导入并生成回执
              </Button>
            </div>
          )}
          {output && (
            <div className="exchange-output">
              <p>
                {output.kind === 'bundle'
                  ? `发送包：${output.changes.length} 个变化`
                  : '导入确认回执'}
              </p>
              <Button
                onClick={() =>
                  void run(async () => {
                    await saveExchangeFile(output);
                    setMessage('文件已保存。');
                  })
                }
              >
                {output.kind === 'bundle' ? '保存发送包' : '保存回执'}
              </Button>
              <details>
                <summary>查看 JSON</summary>
                <Field label="导出的交换 JSON">
                  <textarea readOnly value={JSON.stringify(output, null, 2)} />
                </Field>
              </details>
            </div>
          )}
        </fieldset>
        {message && <p role="status">{message}</p>}
        <ErrorMessage message={error} />
      </details>
    </section>
  );
}
