type NativeCall = (method: string, input: unknown) => Promise<unknown>;
let bridge: NativeCall | undefined;
export const isAndroid = () => Boolean(bridge);
export function installAndroidBridge(call: NativeCall) {
  bridge = call;
}
export async function androidRequest<T>(method: string, input: unknown = {}): Promise<T> {
  if (!bridge) throw new Error('Android 本地运行时不可用');
  return bridge(method, input) as Promise<T>;
}
