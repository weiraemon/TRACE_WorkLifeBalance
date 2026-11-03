import { androidRequest, isAndroid } from './android';
import { exchangeMaxBytes } from '../../../../packages/domain/exchange';

export async function readExchangeFile(file?: File): Promise<string> {
  if (isAndroid()) return androidRequest<string>('readExchange', {});
  if (!file) throw new Error('请选择 JSON 文件');
  if (file.size > exchangeMaxBytes) throw new Error('交换文件超过 512 KiB');
  return new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
}
export async function saveExchangeFile(value: { id: string; kind: string }) {
  const filename = `CHAOS-${value.kind === 'receipt' ? 'receipt' : 'changes'}-${value.id}.json`;
  const text = JSON.stringify(value);
  if (isAndroid()) return androidRequest('saveExchange', { text, filename });
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
