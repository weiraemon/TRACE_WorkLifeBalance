import { useEffect, useState, useMemo } from 'react';
import qrcode from 'qrcode-generator';
import { api, command } from '../../api';
import { Button, ErrorMessage, Field } from '../../components/ui';
import { operationSnapshot, reportOperation, runOperation } from '../../platform/operations';
import { androidRequest, isAndroid } from '../../platform/android';
import {
  encryptWifi,
  decryptWifi,
  parsePairing,
  wifiFrameSchema,
} from '../../../../../packages/domain/wifi-exchange';
import {
  parseExchange,
  type ExchangeBundle,
  type ExchangeReceipt,
  type ExchangePreview,
} from '../../../../../packages/domain/exchange';

type Status = {
  running: boolean;
  pairing?: string;
  expiresAt?: string;
  addresses?: { name: string; address: string }[];
  pending?: { packageId: string; preview: ExchangePreview } | null;
};
export function WifiExchange({
  mobile,
  baseline,
  remember,
  reload,
}: {
  mobile: boolean;
  baseline: ExchangeReceipt | null;
  remember: (receipt: ExchangeReceipt) => void;
  reload: () => Promise<void>;
}) {
  const [status, setStatus] = useState<Status>({ running: false }),
    [host, setHost] = useState('');
  const [pairing, setPairing] = useState(() => sessionStorage.getItem('chaos-wifi-pairing') || ''),
    [pending, setPending] = useState('');
  const [incoming, setIncoming] = useState<{
    bundle: ExchangeBundle;
    preview: ExchangePreview;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const pairingQr = useMemo(() => {
    if (!status.pairing) return '';
    const code = qrcode(0, 'M');
    code.addData(status.pairing);
    code.make();
    return code.createDataURL(5, 20);
  }, [status.pairing]);
  const load = async () => {
    const next = await api<Status>('wifi/status');
    setStatus(next);
    setHost((value) => value || next.addresses?.[0]?.address || '');
  };
  useEffect(() => {
    if (mobile) return;
    let active = true;
    const refresh = async () => {
      if (operationSnapshot()) return;
      try {
        const next = await api<Status>('wifi/status');
        if (active) {
          setStatus(next);
          setHost((value) => value || next.addresses?.[0]?.address || '');
        }
      } catch (error) {
        if (active) setError(String(error));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [mobile]);
  async function talk<T>(input: unknown): Promise<T> {
    const connection = parsePairing(pairing);
    const frame = await encryptWifi(connection.secret, input, 'request');
    reportOperation('正在连接电脑并等待响应');
    const response = wifiFrameSchema.parse(
      await api('wifi/request', { url: connection.url, frame }),
    );
    if (response.requestId !== frame.requestId) throw new Error('响应与本次请求不一致');
    reportOperation('正在解密并校验电脑数据');
    const value = (await decryptWifi(connection.secret, response, 'response')) as T & {
      error?: string;
    };
    if (value.error) throw new Error(value.error);
    return value;
  }
  async function accept(receipt: unknown) {
    const checked = await parseExchange(receipt);
    if (checked.kind !== 'receipt') throw new Error('电脑未返回有效回执');
    remember(checked);
  }
  async function run(task: () => Promise<void>, label = '正在处理 Wi-Fi 连接', cancelable = false) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await runOperation(label, task, cancelable);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!mobile || !pending) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (operationSnapshot()) {
        timer = setTimeout(() => void poll(), 2000);
        return;
      }
      let again = true;
      try {
        const result = await talk<{ receipt: ExchangeReceipt | null; rejected: boolean }>({
          action: 'receipt',
          packageId: pending,
        });
        if (!active) return;
        if (result.receipt) {
          await accept(result.receipt);
          setMessage('电脑已确认导入，共同版本已更新。');
          setPending('');
          again = false;
        } else if (result.rejected) {
          setMessage('电脑已拒绝本次变化，双方内容保持原状。');
          setPending('');
          again = false;
        }
      } catch (error) {
        if (active) {
          setError(String(error));
          setPending('');
        }
        again = false;
      }
      if (active && again) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pending, mobile, pairing]);
  const blocked = (preview: ExchangePreview) =>
    preview.errors.length > 0 || preview.rows.some((row) => row.status === 'conflict');
  function details(preview: ExchangePreview) {
    return (
      <div aria-label="Wi-Fi 变更预览">
        <p>
          新增 {preview.rows.filter((row) => row.status === 'create').length} · 更新{' '}
          {preview.rows.filter((row) => row.status === 'update').length} · 相同{' '}
          {preview.rows.filter((row) => row.status === 'same').length} · 冲突{' '}
          {preview.rows.filter((row) => row.status === 'conflict').length}
        </p>
        <ul>
          {preview.rows.map((row) => (
            <li key={row.id}>
              {row.title}：{row.reason}
            </li>
          ))}
        </ul>
        {preview.missingIds.length > 0 && (
          <p>发送端缺少 {preview.missingIds.length} 个旧对象，不自动删除本机内容。</p>
        )}
        {preview.errors.map((error) => (
          <p role="alert" key={error}>
            {error}
          </p>
        ))}
      </div>
    );
  }
  return (
    <section className="wifi-exchange" aria-label="Wi-Fi 直连">
      <h3>Wi-Fi 直连</h3>
      {!mobile && (
        <p className="hint">
          电脑和手机连接同一 Wi-Fi。电脑开启连接后，手机扫码配对，连接可使用 30 分钟。
        </p>
      )}
      {mobile ? (
        <>
          {isAndroid() && (
            <Button
              className="primary"
              disabled={busy || Boolean(pending)}
              onClick={() =>
                void run(async () => {
                  const value = await androidRequest<string>('scanPairing');
                  parsePairing(value);
                  setPairing(value);
                  sessionStorage.setItem('chaos-wifi-pairing', value);
                  setIncoming(null);
                  setMessage('配对完成，可以读取电脑变化。');
                }, '等待扫描电脑二维码')
              }
            >
              扫码连接电脑
            </Button>
          )}
          <Field label="电脑配对连接">
            <input
              value={pairing}
              autoComplete="off"
              spellCheck={false}
              disabled={busy || Boolean(pending)}
              placeholder="粘贴电脑显示的完整连接"
              onChange={(event) => {
                setPairing(event.target.value);
                sessionStorage.setItem('chaos-wifi-pairing', event.target.value);
                setIncoming(null);
              }}
            />
          </Field>
          <div className="actions">
            <Button
              disabled={busy || !pairing || Boolean(pending)}
              onClick={() =>
                void run(
                  async () => {
                    setIncoming(null);
                    const result = await talk<{ bundle: ExchangeBundle }>({
                      action: 'pull',
                      baseline,
                    });
                    const preview = await command<ExchangePreview>({
                      type: 'exchange.preview',
                      bundle: result.bundle,
                    });
                    setIncoming({ bundle: result.bundle, preview });
                  },
                  '正在读取电脑变化',
                  true,
                )
              }
            >
              读取电脑变化
            </Button>
            <Button
              disabled={busy || !pairing || Boolean(pending) || Boolean(incoming)}
              onClick={() =>
                void run(async () => {
                  const bundle = await command<ExchangeBundle>({
                    type: 'exchange.export',
                    baseline,
                  });
                  const result = await talk<{ receipt?: ExchangeReceipt }>({
                    action: 'offer',
                    bundle,
                  });
                  if (result.receipt) await accept(result.receipt);
                  else {
                    setPending(bundle.id);
                    setMessage('变化已送达，请在电脑设置中确认导入。');
                  }
                }, '正在整理并发送手机变化')
              }
            >
              发送手机变化
            </Button>
          </div>
          {incoming && (
            <>
              {details(incoming.preview)}
              <Button
                className="primary"
                disabled={busy || blocked(incoming.preview)}
                onClick={() =>
                  void run(async () => {
                    const result = await command<{ receipt: ExchangeReceipt }>({
                      type: 'exchange.apply',
                      bundle: incoming.bundle,
                      revision: incoming.preview.revision,
                    });
                    await accept(result.receipt);
                    setIncoming(null);
                    await reload();
                    setMessage('电脑变化已导入本机，正在返回确认。');
                    await talk({ action: 'ack', receipt: result.receipt });
                    setMessage('电脑变化已导入，确认已返回；现在可发送手机变化。');
                  }, '正在导入电脑变化')
                }
              >
                确认导入电脑变化
              </Button>
              <Button disabled={busy} onClick={() => setIncoming(null)}>
                取消预览
              </Button>
            </>
          )}
        </>
      ) : (
        <>
          {!status.running ? (
            <>
              <Field label="电脑局域网地址">
                <select value={host} onChange={(event) => setHost(event.target.value)}>
                  <option value="">请选择</option>
                  {status.addresses?.map((address) => (
                    <option key={address.address} value={address.address}>
                      {address.name} · {address.address}
                    </option>
                  ))}
                </select>
              </Field>
              <Button
                disabled={busy || !host}
                onClick={() =>
                  void run(async () => {
                    await api('wifi/start', { host });
                    await load();
                  })
                }
              >
                开启 Wi-Fi 连接
              </Button>
            </>
          ) : (
            <>
              {pairingQr && (
                <figure className="wifi-pairing-qr">
                  <img src={pairingQr} alt="电脑配对二维码" />
                  <figcaption>手机点击“扫码连接电脑”</figcaption>
                </figure>
              )}
              <details>
                <summary>手动复制配对连接</summary>
                <Field label="电脑配对连接">
                  <textarea readOnly value={status.pairing || ''} />
                </Field>
              </details>
              <p className="hint">
                请选择手机可访问的 Wi-Fi 地址；首次连接需允许 Windows
                防火墙的专用网络访问。不要公开配对连接。
              </p>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api('wifi/stop', {});
                    await load();
                  })
                }
              >
                关闭 Wi-Fi 连接
              </Button>
              {status.pending && (
                <>
                  {details(status.pending.preview)}
                  <Button
                    className="primary"
                    disabled={busy || blocked(status.pending.preview)}
                    onClick={() =>
                      void run(async () => {
                        await api('wifi/confirm', { packageId: status.pending!.packageId });
                        await reload();
                        await load();
                        setMessage('手机变化已导入，确认已发送。');
                      }, '正在导入手机变化')
                    }
                  >
                    确认导入手机变化
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api('wifi/reject', { packageId: status.pending!.packageId });
                        await load();
                      })
                    }
                  >
                    拒绝本次变化
                  </Button>
                </>
              )}
            </>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
      <ErrorMessage message={error} />
    </section>
  );
}
