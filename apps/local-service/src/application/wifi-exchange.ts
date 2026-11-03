import http from 'node:http';
import os from 'node:os';
import { z } from 'zod';
import {
  decryptWifi,
  encryptWifi,
  isPrivateAddress,
  wifiEndpoint,
  wifiFrameSchema,
} from '../../../../packages/domain/wifi-exchange';
import {
  parseExchange,
  type ExchangeBundle,
  type ExchangeReceipt,
  type ExchangePreview,
} from '../../../../packages/domain/exchange';
import type { WorkspaceService } from '../../../../packages/workspace/workspace-service';

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pull'), baseline: z.unknown().optional() }).strict(),
  z.object({ action: z.literal('ack'), receipt: z.unknown() }).strict(),
  z.object({ action: z.literal('offer'), bundle: z.unknown() }).strict(),
  z.object({ action: z.literal('receipt'), packageId: z.string().uuid() }).strict(),
]);
export function wifiAddresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter(
        (address) =>
          address.family === 'IPv4' && !address.internal && isPrivateAddress(address.address),
      )
      .map((address) => ({ name, address: address.address })),
  );
}
async function jsonBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1600000) throw new Error('Wi-Fi 交换数据过大');
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
export async function wifiProxy(url: string, frame: unknown) {
  const response = await fetch(wifiEndpoint(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wifiFrameSchema.parse(frame)),
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error('Wi-Fi 连接已过期、配对信息不正确或请求已使用，请重新连接');
  if (Number(response.headers.get('content-length')) > 1600000) throw new Error('Wi-Fi 响应过大');
  const reader = response.body!.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1600000) throw new Error('Wi-Fi 响应过大');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return wifiFrameSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
export async function startWifiExchange(service: WorkspaceService, host: string) {
  if (!isPrivateAddress(host)) throw new Error('只能在本机局域网地址上开启');
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const sessionId = crypto.randomUUID(),
    seen = new Set<string>();
  const sent = new Map<string, ExchangeBundle>(),
    receipts = new Map<string, ExchangeReceipt>();
  const rejected = new Set<string>();
  let pending: { bundle: ExchangeBundle; preview: ExchangePreview } | undefined;
  let stopped = false;
  const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();
  async function action(input: unknown) {
    const request = requestSchema.parse(input);
    if (request.action === 'pull') {
      const bundle = (await service.execute({
        type: 'exchange.export',
        baseline: request.baseline,
      })) as ExchangeBundle;
      sent.set(bundle.id, bundle);
      if (sent.size > 10) sent.delete(sent.keys().next().value!);
      return { bundle };
    }
    if (request.action === 'ack') {
      const receipt = await parseExchange(request.receipt);
      if (receipt.kind !== 'receipt') throw new Error('缺少确认回执');
      const bundle = sent.get(receipt.packageId);
      if (
        !bundle ||
        bundle.channelId !== receipt.channelId ||
        bundle.changes.some((change) => receipt.hashes[change.data.id] !== change.hash) ||
        Object.entries(receipt.hashes).some(
          ([id, hash]) => hash !== bundle.manifest[id] && hash !== bundle.baseline[id],
        )
      )
        throw new Error('回执与已发送内容不一致，请重新获取电脑变化');
      sent.delete(bundle.id);
      return { acknowledged: true };
    }
    if (request.action === 'receipt')
      return {
        receipt: receipts.get(request.packageId) ?? null,
        rejected: rejected.has(request.packageId),
      };
    const bundle = await parseExchange(request.bundle);
    if (bundle.kind !== 'bundle') throw new Error('需要变更包');
    if (receipts.has(bundle.id)) return { receipt: receipts.get(bundle.id) };
    if (pending && pending.bundle.id !== bundle.id)
      throw new Error('电脑上还有待确认的手机变化，请先处理');
    pending = {
      bundle,
      preview: (await service.execute({ type: 'exchange.preview', bundle })) as ExchangePreview,
    };
    return { pending: true };
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    if (
      stopped ||
      request.method !== 'POST' ||
      request.url !== `/chaos-exchange/${sessionId}` ||
      !request.headers['content-type']?.startsWith('application/json')
    ) {
      response.writeHead(403).end('{}');
      return;
    }
    try {
      const frame = wifiFrameSchema.parse(await jsonBody(request));
      if (seen.has(frame.requestId) || seen.size >= 2048) throw new Error('请求已使用，请重新连接');
      const input = await decryptWifi(secret, frame, 'request');
      seen.add(frame.requestId);
      let result: unknown;
      try {
        result = await action(input);
      } catch (error) {
        result = { error: error instanceof Error ? error.message : '交换失败' };
      }
      if (stopped) {
        response.writeHead(403).end('{}');
        return;
      }
      response.end(JSON.stringify(await encryptWifi(secret, result, 'response', frame.requestId)));
    } catch {
      response.writeHead(403).end('{}');
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  const close = () => {
    stopped = true;
    pending = undefined;
    sent.clear();
    receipts.clear();
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  const timer = setTimeout(close, 30 * 60000);
  timer.unref();
  return {
    close,
    status: () => ({
      running: !stopped,
      pairing: stopped ? '' : `http://${host}:${port}/chaos-exchange/${sessionId}#${secret}`,
      expiresAt,
      pending: pending ? { packageId: pending.bundle.id, preview: pending.preview } : null,
    }),
    async confirm(packageId: string) {
      if (stopped || !pending || pending.bundle.id !== packageId)
        throw new Error('待确认内容已变化');
      const current = pending;
      try {
        const result = (await service.execute({
          type: 'exchange.apply',
          bundle: current.bundle,
          revision: current.preview.revision,
        })) as { receipt: ExchangeReceipt };
        receipts.set(current.bundle.id, result.receipt);
        if (receipts.size > 10) receipts.delete(receipts.keys().next().value!);
        pending = undefined;
      } catch (error) {
        if (!stopped)
          current.preview = (await service.execute({
            type: 'exchange.preview',
            bundle: current.bundle,
          })) as ExchangePreview;
        throw error;
      }
    },
    reject(packageId: string) {
      if (pending?.bundle.id === packageId) {
        pending = undefined;
        rejected.add(packageId);
      }
    },
  };
}
