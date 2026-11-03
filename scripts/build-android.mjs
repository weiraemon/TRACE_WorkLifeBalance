import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const tools = path.join(root, '.android-tools');
const childDirectory = (directory, pattern) =>
  fs.existsSync(directory)
    ? fs.readdirSync(directory).find((name) => pattern.test(name))
    : undefined;
const jdk = childDirectory(path.join(tools, 'jdk'), /^jdk/);
const javaHome = process.env.JAVA_HOME || (jdk && path.join(tools, 'jdk', jdk));
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(tools, 'sdk');
if (!javaHome || !fs.existsSync(sdk))
  throw new Error(
    '需要 JDK 21 和 Android SDK 35；设置 JAVA_HOME 与 ANDROID_HOME，或使用 Android Studio 的工具链。',
  );
const native = path.join(root, 'apps/android/native');
const gradle = childDirectory(path.join(tools, 'gradle'), /^gradle-/);
const executable = gradle
  ? path.join(
      tools,
      'gradle',
      gradle,
      'bin',
      process.platform === 'win32' ? 'gradle.bat' : 'gradle',
    )
  : path.join(native, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
fs.mkdirSync(tools, { recursive: true });
const debugKey = path.join(tools, 'debug.keystore');
if (!fs.existsSync(debugKey)) {
  const key = spawnSync(
    path.join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool'),
    [
      '-genkeypair',
      '-keystore',
      debugKey,
      '-storepass',
      'android',
      '-alias',
      'androiddebugkey',
      '-keypass',
      'android',
      '-dname',
      'CN=Android Debug,O=Android,C=US',
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '10000',
    ],
    { stdio: 'inherit' },
  );
  if (key.status !== 0) process.exit(key.status ?? 1);
}
fs.writeFileSync(
  path.join(native, 'local.properties'),
  'sdk.dir=' + sdk.replaceAll('\\', '/') + '\n',
);
const tasks = process.argv.slice(2);
if (tasks.some((task) => !/^[\w:-]+$/.test(task))) throw new Error('只接受 Gradle 任务名');
if (!tasks.length) tasks.push(':app:assembleDebug', ':app:assembleDebugAndroidTest');
const args = ['--no-daemon', '--console=plain', ...tasks];
const result = spawnSync(
  process.platform === 'win32' ? 'cmd.exe' : executable,
  process.platform === 'win32' ? ['/d', '/s', '/c', `""${executable}" ${args.join(' ')}"`] : args,
  {
    cwd: native,
    stdio: 'inherit',
    windowsVerbatimArguments: process.platform === 'win32',
    env: {
      ...process.env,
      JAVA_HOME: javaHome,
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      GRADLE_USER_HOME: path.join(tools, 'gradle-cache'),
    },
  },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const apk = path.join(native, 'app/build/outputs/apk/debug/app-debug.apk');
if (fs.existsSync(apk)) {
  const archive = spawnSync(
    path.join(javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar'),
    ['tf', apk],
    { encoding: 'utf8' },
  );
  assert.equal(archive.status, 0, '无法检查 APK 内容');
  const entries = archive.stdout.split(/\r?\n/);
  assert.ok(
    entries.includes('assets/public/index.html') && entries.includes('classes.dex'),
    'APK 缺少应用界面或运行时',
  );
  for (const entry of entries)
    assert.ok(
      !/(?:^|\/)(?:\.atlas|\.test-vault|\.android-tools|\.chaos\.local\.json|workspace\.json|settings\.json|[^/]*\.(?:jks|keystore))(?:\/|$)/i.test(
        entry,
      ),
      'APK 包含本机数据或凭据：' + entry,
    );
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const output = path.join(root, 'releases', `CHAOS-Android-${version}-debug.apk`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(apk, output);
  fs.writeFileSync(
    output + '.sha256',
    createHash('sha256').update(fs.readFileSync(output)).digest('hex') +
      '  ' +
      path.basename(output) +
      '\n',
  );
  console.log('Android development APK: ' + output);
}
