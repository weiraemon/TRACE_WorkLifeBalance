import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { qqSetupArguments } from './qq-setup';
import { discoverQq } from './qq-discovery';
import path from 'node:path';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { externalLink } from './links';

const androidPreview = process.argv.includes('--android-preview');
app.setName(androidPreview ? 'CHAOS Android Preview' : 'CHAOS');
app.setAppUserModelId(androidPreview ? 'cn.chaos.android.preview' : 'cn.chaos.workbench');
app.setPath(
  'userData',
  process.env.CHAOS_DESKTOP_USER_DATA ||
    path.join(
      app.getPath('appData'),
      androidPreview ? 'CHAOS-Android-Preview' : 'CHAOS',
      'desktop',
    ),
);
const root = app.getAppPath();
let window: BrowserWindow | undefined;
let service: ChildProcess | undefined;
let quitting = false;
let stopped = false;
let origin = '';
let qqSetupRunning = false;
let wechatSetupRunning = false;

function trustedSender(event: Electron.IpcMainInvokeEvent) {
  if (
    !window ||
    event.senderFrame !== window.webContents.mainFrame ||
    new URL(event.senderFrame.url).origin !== origin
  )
    throw new Error('不允许的桌面操作来源');
}

async function start() {
  const configDirectory =
    process.env.CHAOS_CONFIG_DIR ||
    path.join(app.getPath('appData'), androidPreview ? 'CHAOS-Android-Preview' : 'CHAOS');
  if (androidPreview) {
    const directory = path.join(configDirectory, 'sample-workspace');
    await fs.mkdir(directory, { recursive: true });
    if ((await fs.readdir(directory)).length === 0) {
      const sample = fork(path.join(root, 'sample-vault.mjs'), [directory], {
        execPath: process.execPath,
        windowsHide: true,
        silent: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      sample.stdout?.resume();
      sample.stderr?.resume();
      const [code] = await once(sample, 'exit');
      if (code !== 0) throw new Error('无法创建预览示例目录，请检查本机目录权限。');
    }
    await fs.writeFile(
      path.join(configDirectory, 'workspace.json'),
      JSON.stringify({ vaultPath: directory }),
    );
  }
  const python = path.join(root, 'runtime', 'python', 'python.exe');
  service = fork(path.join(root, 'apps', 'local-service', 'src', 'server.mjs'), ['--production'], {
    execPath: process.execPath,
    cwd: root,
    silent: true,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ATLAS_PORT: process.env.ATLAS_PORT || (androidPreview ? '0' : '4317'),
      ...(androidPreview ? { CHAOS_CONFIG_DIR: configDirectory } : {}),
      ATLAS_CONFIG_PATH:
        process.env.ATLAS_CONFIG_PATH || path.join(configDirectory, 'workspace.json'),
      CHAOS_BUNDLED_PYTHON: python,
    },
  });
  service.stdout?.resume();
  // Do not persist service output: it may contain user paths or remote error bodies.
  service.stderr?.resume();
  origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('本地服务启动超时')), 30000);
    service!.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    service!.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('本地服务未能启动，请先关闭旧版 CHAOS。'));
    });
    service!.on('message', (message: unknown) => {
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'ready' &&
        'port' in message &&
        Number.isInteger(message.port)
      ) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${message.port}`);
      }
    });
  });
  service.on('exit', () => {
    if (!quitting) {
      dialog.showErrorBox(
        'CHAOS 本地服务已停止',
        '请重新打开桌面版。如果仍无法启动，请检查工作目录是否可访问。',
      );
      app.quit();
    }
  });
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    title: androidPreview ? 'CHAOS · Android 界面预览' : 'CHAOS',
    width: androidPreview ? 390 : 1440,
    height: androidPreview ? 844 : 960,
    useContentSize: androidPreview,
    minWidth: androidPreview ? 360 : 860,
    minHeight: androidPreview ? 500 : 620,
    backgroundColor: '#f7f8f3',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(root, 'icon.png'),
    webPreferences: {
      preload: path.join(root, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      openExternal(url);
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => {
    window = undefined;
  });
  ipcMain.handle('chaos:choose-directory', async (event) => {
    trustedSender(event);
    const result = await dialog.showOpenDialog(window!, {
      title: '选择 Markdown 工作目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle(
    'chaos:discover-qq',
    async (event, input: { seed?: string; browse?: boolean } = {}) => {
      trustedSender(event);
      if (input.browse) {
        const selection = await dialog.showOpenDialog(window!, {
          title: '选择 QQ 数据所在文件夹（可选择上级目录）',
          properties: ['openDirectory'],
        });
        if (selection.canceled) return null;
        return discoverQq(selection.filePaths);
      }
      const roots = [path.join(app.getPath('documents'), 'Tencent Files')];
      if (typeof input.seed === 'string' && path.isAbsolute(input.seed)) roots.unshift(input.seed);
      try {
        const config = JSON.parse(
          await fs.readFile(path.join(configDirectory, 'settings.json'), 'utf8'),
        );
        if (typeof config.qq?.dataDir === 'string') roots.unshift(config.qq.dataDir);
      } catch {
        /* First setup has no saved configuration. */
      }
      for (const drive of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        for (const relative of ['Tencent Files', 'qq_files', 'SoftwareData/QQ/Tencent Files'])
          roots.push(path.join(`${drive}:\\`, relative));
      }
      return discoverQq(roots);
    },
  );
  ipcMain.handle('chaos:setup-qq', async (event, input: unknown) => {
    trustedSender(event);
    if (qqSetupRunning) throw new Error('QQ 初始化正在进行，请先完成当前操作');
    qqSetupArguments(root, input);
    qqSetupRunning = true;
    const resultDirectory = await fs
      .mkdtemp(path.join(app.getPath('temp'), 'chaos-qq-result-'))
      .catch((error) => {
        qqSetupRunning = false;
        throw error;
      });
    const resultFile = path.join(resultDirectory, 'result.txt');
    const args = qqSetupArguments(root, input, resultFile);
    let setupPid = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        // Start-Process gives the interactive tool its own console and input handles.
        // All arguments here are fixed flags or base64, never raw user input.
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Start-Process -FilePath powershell.exe -ArgumentList '${args.join(' ')}' -WindowStyle Normal -PassThru -ErrorAction Stop).Id`,
          ],
          {
            cwd: root,
            windowsHide: true,
            env: { ...process.env, CHAOS_CONFIG_DIR: configDirectory },
          },
          (error, stdout) => {
            if (error) reject(new Error('无法打开 QQ 初始化工具'));
            else {
              setupPid = Number(stdout.trim());
              resolve();
            }
          },
        );
      });
      const deadline = Date.now() + 15 * 60 * 1000;
      while (Date.now() < deadline) {
        const result = await fs.readFile(resultFile, 'utf8').catch(() => '');
        if (result === 'success') return;
        if (result === 'failed') throw new Error('初始化未完成，请查看命令行中的提示后重试');
        if (setupPid) {
          try {
            process.kill(setupPid, 0);
          } catch {
            throw new Error('初始化窗口已关闭，尚未收到成功结果，请重试');
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error('等待初始化超时。请检查命令行；若已成功，可点击“重新加载 QQ 同步”。');
    } finally {
      qqSetupRunning = false;
      await fs.unlink(resultFile).catch(() => {});
      await fs.rmdir(resultDirectory).catch(() => {});
    }
  });
  ipcMain.handle('chaos:setup-wechat', async (event) => {
    trustedSender(event);
    if (wechatSetupRunning) throw new Error('微信初始化正在进行，请先完成当前操作');
    const selection = await dialog.showOpenDialog(window!, {
      title: '选择微信 xwechat_files 或账号目录', properties: ['openDirectory'],
    });
    if (selection.canceled) return false;
    wechatSetupRunning = true;
    try {
      const script = path.join(root, 'scripts', 'setup-wechat.ps1').replaceAll("'", "''");
      const encoded = Buffer.from(`& '${script}' -DataDir $env:CHAOS_WECHAT_DATA_DIR`, 'utf16le').toString('base64');
      const command = `$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}' -WindowStyle Normal -Wait -PassThru -ErrorAction Stop; Write-Output $p.ExitCode`;
      const code = await new Promise<number>((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
          cwd: root, windowsHide: true, timeout: 15 * 60 * 1000,
          env: { ...process.env, CHAOS_CONFIG_DIR: configDirectory,
            CHAOS_WECHAT_DATA_DIR: selection.filePaths[0] },
        }, (error, stdout) => {
          if (error) reject(new Error('微信初始化工具未能完成，请重试'));
          else resolve(Number(stdout.trim()));
        });
      });
      if (code !== 0) throw new Error('微信初始化失败，请按命令行提示检查后重试');
      return true;
    } finally {
      wechatSetupRunning = false;
    }
  });
  await window.loadURL(androidPreview ? `${origin}/?ui=android` : origin);
}

function openExternal(value: string) {
  const url = externalLink(value);
  if (url)
    void shell
      .openExternal(url)
      .catch(() => dialog.showErrorBox('无法打开资源', '请确认已安装对应的浏览器或 Obsidian。'));
}

app.on('before-quit', (event) => {
  if (stopped) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void (async () => {
    if (service?.pid && service.exitCode === null && service.signalCode === null) {
      const exited = once(service, 'exit');
      if (service.connected) service.send({ type: 'shutdown' });
      const timer = setTimeout(() => service?.kill(), 5000);
      await exited;
      clearTimeout(timer);
    }
    stopped = true;
    app.quit();
  })();
});
app.on('window-all-closed', () => app.quit());
if (!app.requestSingleInstanceLock()) {
  stopped = true;
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      dialog.showErrorBox(
        'CHAOS 无法启动',
        error instanceof Error ? error.message : '请重新打开桌面版。',
      );
      app.quit();
    });
}
