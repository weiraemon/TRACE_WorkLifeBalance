import { z } from 'zod';
import { canonicalJson } from './exchange';

export const wifiFrameSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().uuid(),
    iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
    payload: z
      .string()
      .min(24)
      .max(1500000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type WifiFrame = z.infer<typeof wifiFrameSchema>;
export function isPrivateAddress(host: string) {
  const parts = host.split('.').map(Number);
  return (
    /^\d+\.\d+\.\d+\.\d+$/.test(host) &&
    parts.every((part) => part >= 0 && part <= 255) &&
    (parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31))
  );
}
export function wifiEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !isPrivateAddress(url.hostname) ||
    url.username ||
    url.password ||
    Number(url.port) < 1024 ||
    Number(url.port) > 65535 ||
    url.search ||
    url.hash ||
    !/^\/chaos-exchange\/[a-f0-9-]{36}$/.test(url.pathname)
  )
    throw new Error('仅允许连接本地 Wi-Fi 的 CHAOS 配对地址');
  return url.href;
}
export function parsePairing(value: string) {
  const url = new URL(value.trim()),
    secret = url.hash.slice(1);
  url.hash = '';
  if (!/^[a-f0-9]{32}$/.test(secret))
    throw new Error('配对信息不完整，请复制电脑显示的完整配对连接');
  return { url: wifiEndpoint(url.href), secret };
}
const bytes = (text: string) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
function base64(data: Uint8Array) {
  let text = '';
  for (let start = 0; start < data.length; start += 16384)
    text += String.fromCharCode(...data.subarray(start, start + 16384));
  return btoa(text);
}
async function key(secret: string) {
  if (!/^[a-f0-9]{32}$/.test(secret)) throw new Error('非法配对密钥');
  return crypto.subtle.importKey(
    'raw',
    Uint8Array.from(secret.match(/../g)!, (hex) => parseInt(hex, 16)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}
export async function encryptWifi(
  secret: string,
  input: unknown,
  direction: 'request' | 'response',
  requestId: string = crypto.randomUUID(),
): Promise<WifiFrame> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(`chaos-wifi-v1:${direction}:${requestId}`),
    },
    await key(secret),
    new TextEncoder().encode(canonicalJson(input)),
  );
  return { version: 1, requestId, iv: base64(iv), payload: base64(new Uint8Array(payload)) };
}
export async function decryptWifi(
  secret: string,
  input: unknown,
  direction: 'request' | 'response',
) {
  const frame = wifiFrameSchema.parse(input);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bytes(frame.iv),
      additionalData: new TextEncoder().encode(`chaos-wifi-v1:${direction}:${frame.requestId}`),
    },
    await key(secret),
    bytes(frame.payload),
  );
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as unknown;
}
