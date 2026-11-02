import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.argv[2], 'Usage: npm run test:release -- path/to/CHAOS-Windows-x64.zip');
const zip = path.resolve(process.argv[2]);
const digest = createHash('sha256')
  .update(await fs.readFile(zip))
  .digest('hex');
assert.equal(
  (await fs.readFile(path.join(path.dirname(zip), 'SHA256SUMS.txt'), 'utf8')).trim(),
  digest + '  ' + path.basename(zip),
  'Release ZIP checksum mismatch.',
);
const staging = path.join(project, '.test-vault');
await fs.mkdir(staging, { recursive: true });
const extracted = await fs.mkdtemp(path.join(staging, 'release verify '));
try {
  const python = path.join(project, '.desktop', 'runtime', 'python', 'python.exe');
  execFileSync(
    python,
    [
      '-c',
      "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None, 'ZIP CRC mismatch'; z.extractall(sys.argv[2])",
      zip,
      extracted,
    ],
    { windowsHide: true, stdio: 'inherit' },
  );
  const executable = path.join(extracted, 'CHAOS-win32-x64', 'CHAOS.exe');
  assert.ok((await fs.stat(executable)).isFile(), 'Release ZIP does not contain CHAOS.exe.');
  const require = createRequire(import.meta.url);
  execFileSync(
    process.execPath,
    [
      require.resolve('@playwright/test/cli'),
      'test',
      '--config',
      path.join(project, 'playwright.desktop.config.ts'),
    ],
    {
      cwd: project,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, CHAOS_DESKTOP_EXECUTABLE: executable },
    },
  );
} finally {
  assert.equal(path.dirname(await fs.realpath(extracted)), await fs.realpath(staging));
  await fs.rm(extracted, { recursive: true, force: true });
}
