import { WorkspaceService } from '../../../packages/workspace/workspace-service';
import { businessApiVersion } from '../../../packages/domain/business';
import { AndroidWorkspace, type DirectorySession, type NativeCall } from './workspace';

export function createAndroidTransport(native: NativeCall) {
  let vault: AndroidWorkspace | undefined;
  let service: WorkspaceService | undefined;
  let switching = false;
  const activate = async (directory: DirectorySession) => {
    const next = new AndroidWorkspace(directory, native);
    const snapshot = await next.snapshot();
    vault = next;
    service = new WorkspaceService(next);
    return snapshot;
  };
  return async (route: string, input?: unknown): Promise<unknown> => {
    const body = (input ?? {}) as Record<string, any>;
    if (route === 'session') {
      try {
        const directory = await native<DirectorySession | null>('session');
        if (directory) await activate(directory);
        return {
          connected: Boolean(vault),
          root: directory?.root ?? '',
          vaultId: directory?.vaultId ?? '',
          token: '',
        };
      } catch (error) {
        return {
          connected: false,
          root: '',
          vaultId: '',
          token: '',
          connectionError: String(error),
        };
      }
    }
    if (route === 'connect') {
      if (switching) throw new Error('正在切换目录，请稍后重试');
      switching = true;
      try {
        const directory = await native<DirectorySession>('chooseDirectory');
        vault = undefined;
        service = undefined;
        const snapshot = await activate(directory);
        await native('remember', directory);
        return snapshot;
      } finally {
        switching = false;
      }
    }
    if (!vault || !service || switching) throw new Error('请先选择有效的 Markdown 工作目录');
    switch (route) {
      case 'business/v1/workspace':
        return { version: businessApiVersion, snapshot: await service.snapshot() };
      case 'business/v1/commands':
        return { version: businessApiVersion, result: await service.execute(input) };
      case 'backups':
        return vault.backups();
      case 'backup':
        return vault.backup();
      case 'restore':
        return vault.restore(String(body.id), body.expectations);
      case 'open':
        return vault.open(String(body.id));
      case 'export':
        return vault.exportDirectory();
      case 'wifi/request':
        return JSON.parse(
          await native<string>('wifiRequest', {
            vaultId: vault.directory.vaultId,
            url: body.url,
            body: JSON.stringify(body.frame),
          }),
        );
      default:
        throw new Error('Android 首版不支持此平台操作：' + route);
    }
  };
}
