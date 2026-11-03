import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../apps/local-service/src/native/vault';
import { workspaceServiceFor } from '../packages/workspace/workspace-service';
import { createRecord } from '../packages/domain/index';
import {
  decryptWifi,
  encryptWifi,
  parsePairing,
  wifiEndpoint,
} from '../packages/domain/wifi-exchange';
import { startWifiExchange, wifiProxy } from '../apps/local-service/src/application/wifi-exchange';
import type { ExchangeBundle, ExchangePreview, ExchangeReceipt } from '../packages/domain/exchange';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-wifi-'));
  const vault = await Vault.open(directory),
    service = workspaceServiceFor(vault);
  cleanup.push(async () => {
    await vault.close();
    expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(directory)).toMatch(/^chaos-wifi-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return service;
}
it('加密 Wi-Fi 拉取、回执和手机推送；电脑确认前不写入，确认后可增量回传', async () => {
  const desktop = await fixture(),
    mobile = await fixture();
  const project = await desktop.saveRecord(createRecord('project', { title: 'Wi-Fi 项目' }));
  const session = await startWifiExchange(desktop, '127.0.0.1');
  cleanup.push(async () => session.close());
  const pairing = parsePairing(session.status().pairing);
  const talk = async (input: unknown) => {
    const frame = await encryptWifi(pairing.secret, input, 'request');
    expect(JSON.stringify(frame)).not.toContain('Wi-Fi 项目');
    const response = await wifiProxy(pairing.url, frame);
    expect(response.requestId).toBe(frame.requestId);
    return (await decryptWifi(pairing.secret, response, 'response')) as any;
  };
  const pulled = (await talk({ action: 'pull' })) as { bundle: ExchangeBundle };
  const preview = (await mobile.execute({
    type: 'exchange.preview',
    bundle: pulled.bundle,
  })) as ExchangePreview;
  const result = (await mobile.execute({
    type: 'exchange.apply',
    bundle: pulled.bundle,
    revision: preview.revision,
  })) as { receipt: ExchangeReceipt };
  expect(await talk({ action: 'ack', receipt: result.receipt })).toEqual({ acknowledged: true });
  expect((await talk({ action: 'pull', baseline: result.receipt })).bundle.changes).toHaveLength(0);
  const current = (await mobile.snapshot()).entries.find(
    (entry) => entry.data.id === project.data.id,
  )!;
  await mobile.saveRecord({ ...current.data, title: '手机改动' }, current.revision);
  const bundle = (await mobile.execute({
    type: 'exchange.export',
    baseline: result.receipt,
  })) as ExchangeBundle;
  expect(await talk({ action: 'offer', bundle })).toEqual({ pending: true });
  expect((await desktop.snapshot()).entries[0].data).toHaveProperty('title', 'Wi-Fi 项目');
  expect(session.status().pending?.preview.rows[0].status).toBe('update');
  await session.confirm(bundle.id);
  expect((await desktop.snapshot()).entries[0].data).toHaveProperty('title', '手机改动');
  expect((await talk({ action: 'receipt', packageId: bundle.id })).receipt).toHaveProperty(
    'packageId',
    bundle.id,
  );
  expect((await talk({ action: 'offer', bundle })).receipt).toHaveProperty('packageId', bundle.id);
});

it('拒绝错误密钥、篡改、请求重放、反射响应、公网与非协议地址；关闭即失效', async () => {
  const service = await fixture(),
    session = await startWifiExchange(service, '127.0.0.1');
  cleanup.push(async () => session.close());
  const pairing = parsePairing(session.status().pairing),
    frame = await encryptWifi(pairing.secret, { action: 'pull' }, 'request');
  const response = await wifiProxy(pairing.url, frame);
  await expect(wifiProxy(pairing.url, frame)).rejects.toThrow();
  await expect(decryptWifi(pairing.secret, response, 'request')).rejects.toThrow();
  const wrong =
    pairing.secret[0] === '0' ? '1' + pairing.secret.slice(1) : '0' + pairing.secret.slice(1);
  await expect(
    wifiProxy(pairing.url, await encryptWifi(wrong, { action: 'pull' }, 'request')),
  ).rejects.toThrow();
  for (const url of [
    'http://8.8.8.8:4317/chaos-exchange/00000000-0000-0000-0000-000000000000',
    pairing.url + '?path=work',
    'http://localhost:4317/api/session',
  ])
    expect(() => wifiEndpoint(url)).toThrow();
  session.close();
  expect(session.status().pairing).toBe('');
  await expect(
    wifiProxy(pairing.url, await encryptWifi(pairing.secret, { action: 'pull' }, 'request')),
  ).rejects.toThrow();
});

it('电脑预览后更改时重新检查；拒绝推送不会修改业务内容', async () => {
  const service = await fixture(),
    source = await fixture();
  await source.saveRecord(createRecord('project', { title: '等待确认' }));
  const bundle = (await source.execute({ type: 'exchange.export' })) as ExchangeBundle;
  const session = await startWifiExchange(service, '127.0.0.1');
  cleanup.push(async () => session.close());
  const pairing = parsePairing(session.status().pairing);
  const offer = async () =>
    wifiProxy(
      pairing.url,
      await encryptWifi(pairing.secret, { action: 'offer', bundle }, 'request'),
    );
  await offer();
  await service.saveRecord(createRecord('project', { title: '电脑新改动' }));
  await expect(session.confirm(bundle.id)).rejects.toThrow('预览');
  expect((await service.snapshot()).entries).toHaveLength(1);
  session.reject(bundle.id);
  const response = await wifiProxy(
    pairing.url,
    await encryptWifi(pairing.secret, { action: 'receipt', packageId: bundle.id }, 'request'),
  );
  expect(await decryptWifi(pairing.secret, response, 'response')).toHaveProperty('rejected', true);
});
