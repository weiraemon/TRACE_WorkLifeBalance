import { businessApiVersion, type BusinessCommand } from '../../../../packages/domain/business';
import { recordContract } from '../../../../packages/domain/index';

let token = '';
let vaultId = '';
type PlatformTransport = (route: string, body?: unknown) => Promise<unknown>;
let platformTransport: PlatformTransport | undefined;
// Installed by the Android application runtime, never by a page or a storage component.
export function installPlatformTransport(transport: PlatformTransport) {
  platformTransport = transport;
}
export async function api<T>(route: string, body?: unknown): Promise<T> {
  if (platformTransport) return platformTransport(route, body) as Promise<T>;
  const response = await fetch('/api/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'X-Atlas-Token': token,
      'X-Atlas-Vault': vaultId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.headers.get('X-Atlas-Contract') !== recordContract)
    throw new Error(
      '前端与本地服务的数据模型不一致。请在原终端按 Ctrl+C 停止旧服务，然后在当前项目目录执行 npm run build 和 npm start，刷新页面后重试。未保存的输入请先复制保留。',
    );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '请求失败');
  if (route === 'connect') vaultId = value.vaultId;
  return value;
}
export async function session() {
  const value = await api<{
    token: string;
    connected: boolean;
    root: string;
    vaultId: string;
    connectionError?: string;
  }>('session');
  token = value.token;
  vaultId = value.vaultId;
  return value;
}

export async function businessRequest<T>(route: 'workspace' | 'commands', input?: BusinessCommand) {
  const response = await api<T & { version: string }>('business/v1/' + route, input);
  if (response.version !== businessApiVersion)
    throw new Error('业务接口版本不一致，请更新应用并刷新页面');
  return response;
}
