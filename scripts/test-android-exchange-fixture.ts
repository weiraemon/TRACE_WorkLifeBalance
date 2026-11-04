import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Vault } from '../apps/local-service/src/native/vault';
import { workspaceServiceFor } from '../packages/workspace/workspace-service';
import { createRecord } from '../packages/domain/index';
import type { ExchangeBundle, ExchangePreview } from '../packages/domain/exchange';
import { startWifiExchange } from '../apps/local-service/src/application/wifi-exchange';
import http from 'node:http';

const directory = path.resolve(process.argv[2]);
assert.equal(path.dirname(directory), path.resolve('.test-vault'));
assert.match(path.basename(directory), /^android-exchange-[A-Za-z0-9]+$/);
await fs.mkdir(path.join(directory, 'windows'), { recursive: true });
const vault = await Vault.open(path.join(directory, 'windows'));
const service = workspaceServiceFor(vault);
try {
  if (process.argv[3] === 'wifi-hang') {
    const server = http.createServer((request) => {
      request.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await fs.writeFile(
      path.join(directory, 'wifi.json'),
      JSON.stringify({
        pairing: `http://10.0.2.2:${port}/chaos-exchange/00000000-0000-0000-0000-000000000000#00000000000000000000000000000000`,
      }),
    );
    process.send?.({ type: 'ready' });
    await new Promise<void>((resolve) => {
      process.once('disconnect', resolve);
      process.on('message', (message: { type: string }) => {
        if (message.type === 'stop') resolve();
      });
    });
    server.close();
    server.closeAllConnections();
    process.disconnect?.();
  } else if (process.argv[3] === 'wifi') {
    const suffix = path.basename(directory).replace('android-exchange-', '');
    const title = 'WiFi电脑新建 ' + suffix,
      phoneTitle = 'WiFi手机回传 ' + suffix;
    await service.saveRecord(createRecord('project', { title }));
    const session = await startWifiExchange(service, '127.0.0.1');
    await fs.writeFile(
      path.join(directory, 'wifi.json'),
      JSON.stringify({
        pairing: session.status().pairing.replace('127.0.0.1', '10.0.2.2'),
        title,
        phoneTitle,
      }),
    );
    process.send?.({ type: 'ready' });
    try {
      await new Promise<void>((resolve) => {
        process.once('disconnect', resolve);
        process.on('message', async (message: { type: string }) => {
          if (message.type === 'stop') {
            resolve();
            return;
          }
          if (message.type !== 'confirm') return;
          try {
            const before = await service.snapshot();
            assert.ok(
              !before.entries.some(
                (entry) => 'title' in entry.data && entry.data.title === phoneTitle,
              ),
            );
            const pending = session.status().pending;
            assert.ok(pending);
            await session.confirm(pending.packageId);
            assert.ok(
              (await service.snapshot()).entries.some(
                (entry) => 'title' in entry.data && entry.data.title === phoneTitle,
              ),
            );
            process.send?.({ type: 'confirmed' });
          } catch (error) {
            process.send?.({ type: 'error', error: String(error) });
          }
        });
      });
    } finally {
      session.close();
      process.disconnect?.();
    }
  } else if (process.argv[3] === 'verify') {
    const bundle = JSON.parse(
      await fs.readFile(path.join(directory, 'reply.json'), 'utf8'),
    ) as ExchangeBundle;
    const preview = (await service.execute({
      type: 'exchange.preview',
      bundle,
    })) as ExchangePreview;
    assert.deepEqual(preview.errors, []);
    assert.ok(!preview.rows.some((row) => row.status === 'conflict'));
    await service.execute({ type: 'exchange.apply', bundle, revision: preview.revision });
    const metadata = JSON.parse(await fs.readFile(path.join(directory, 'metadata.json'), 'utf8'));
    const snapshot = await service.snapshot();
    assert.deepEqual(snapshot.issues, []);
    const todo = snapshot.entries.find((entry) => entry.data.id === metadata.todoId)!.data;
    assert.ok('completedAt' in todo && todo.completedAt);
    const note = (await service.execute({ type: 'notes.read', id: metadata.lineId })) as {
      body: string;
    };
    assert.ok(note.body.includes(metadata.memo));
    console.log('Windows → Android SAF → Windows JSON roundtrip passed.');
  } else {
    const suffix = path.basename(directory).replace('android-exchange-', '');
    const lineTitle = '文件交换验收 ' + suffix,
      todoTitle = '交换待办 ' + suffix,
      memo = '手机回传笔记 ' + suffix;
    const project = await service.saveRecord(
      createRecord('project', { title: '电脑交换项目 ' + suffix }),
    );
    const line = await service.saveRecord(
      createRecord('workline', { title: lineTitle, projectId: project.data.id }),
    );
    const pool = (await service.snapshot()).entries.find(
      (entry) =>
        entry.data.type === 'milestone' && entry.data.pool && entry.data.lineId === line.data.id,
    )!;
    const todo = await service.saveRecord(
      createRecord('todo', { title: todoTitle, milestoneId: pool.data.id }),
    );
    const bundle = await service.execute({ type: 'exchange.export' });
    await fs.writeFile(path.join(directory, 'send.json'), JSON.stringify(bundle));
    await fs.writeFile(
      path.join(directory, 'metadata.json'),
      JSON.stringify({ lineTitle, todoTitle, lineId: line.data.id, todoId: todo.data.id, memo }),
    );
  }
} finally {
  await vault.close();
}
