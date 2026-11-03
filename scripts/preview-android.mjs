import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const directory = path.join(root, '.test-vault/android-preview');
const cli = path.join(root, 'node_modules/tsx/dist/cli.mjs');
if (!fs.existsSync(directory)) {
  const sample = spawnSync(process.execPath, [cli, 'scripts/sample-vault.ts', directory], {
    cwd: root,
    stdio: 'inherit',
  });
  if (sample.status !== 0) process.exit(sample.status ?? 1);
}
const config = path.join(root, '.test-vault/android-preview-config.json');
fs.writeFileSync(config, JSON.stringify({ vaultPath: directory }));
const child = spawn(process.execPath, [cli, 'apps/local-service/src/server.ts'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    ATLAS_PORT: '4320',
    ATLAS_CONFIG_PATH: config,
    CHAOS_CONFIG_DIR: path.join(root, '.test-vault/android-preview-app-config'),
  },
});
console.log(
  '手机界面预览：http://127.0.0.1:4320/?ui=android（独立合成目录；Android 文件功能请运行 npm run test:android）',
);
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
