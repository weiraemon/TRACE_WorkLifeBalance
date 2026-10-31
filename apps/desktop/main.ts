import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { once } from 'node:events';
import { externalLink } from './links';

app.setName('CHAOS');
app.setAppUserModelId('cn.chaos.workbench');
app.setPath(
  'userData',
  process.env.CHAOS_DESKTOP_USER_DATA || path.join(app.getPath('appData'), 'CHAOS', 'desktop'),
);
const root = app.getAppPath();
let window: BrowserWindow | undefined;
let service: ChildProcess | undefined;
let quitting = false;
let stopped = false;
let origin = '';

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
    process.env.CHAOS_CONFIG_DIR || path.join(app.getPath('appData'), 'CHAOS');
  const python = path.join(root, 'runtime', 'python', 'python.exe');
  service = fork(path.join(root, 'apps', 'local-service', 'src', 'server.mjs'), ['--production'], {
    execPath: process.execPath,
    cwd: root,
    silent: true,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ATLAS_PORT: process.env.ATLAS_PORT || '4317',
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
    title: 'CHAOS',
    width: 1440,
    height: 960,
    minWidth: 860,
    minHeight: 620,
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
  ipcMain.handle('chaos:setup-qq', async (event) => {
    trustedSender(event);
    const error = await shell.openPath(path.join(root, 'setup-qq.cmd'));
    if (error) throw new Error('无法打开 QQ 初始化工具');
  });
  await window.loadURL(origin);
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
