import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  aiDefaults,
  aiProviderSchema,
  aiProviders,
  type AiProfileSettings,
  type AiProfileView,
  type AiProvider,
  type AiSettings,
  type AiView,
} from '../../../packages/domain/messages';

// App-level settings live outside the Markdown Vault: they are machine secrets,
// not user notes, and must not be copied by Vault backups or synced folders.
const fileName = 'settings.json';
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function configDir() {
  const override = process.env.CHAOS_CONFIG_DIR?.trim();
  if (override) return path.resolve(override);
  const home = os.homedir();
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'CHAOS');
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'CHAOS');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'chaos');
}

export const configPath = () => path.join(configDir(), fileName);

export function qqCacheDir() {
  const override = process.env.CHAOS_CACHE_DIR?.trim();
  if (override) return path.resolve(override);
  const home = os.homedir();
  if (process.platform === 'win32')
    return path.join(
      process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
      'CHAOS',
      'qq-cache',
    );
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Caches', 'CHAOS', 'qq-cache');
  return path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'chaos', 'qq-cache');
}

type Stored = Record<string, unknown>;
const record = (value: unknown): value is Stored =>
  !!value && typeof value === 'object' && !Array.isArray(value);

async function readRaw(): Promise<Stored> {
  let text: string;
  try {
    text = await fs.readFile(configPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {};
  }
  try {
    const value: unknown = JSON.parse(text);
    return record(value) ? value : {};
  } catch {
    // A hand-edited or truncated settings file must not block the app; saving
    // replaces it with valid JSON, and secrets are never logged.
    return {};
  }
}

export type AiProfile = AiProfileSettings & { key: string };
export type AiConfig = {
  provider: AiProvider;
  profiles: Record<AiProvider, AiProfile>;
};

const text = (value: unknown, max: number, fallback: string) =>
  typeof value === 'string' ? value.trim().slice(0, max) : fallback;

function normalizeProfile(provider: AiProvider, value: unknown): AiProfile {
  const fallback = aiDefaults[provider];
  const stored = record(value) ? value : {};
  return {
    baseUrl: text(stored.baseUrl, 500, fallback.baseUrl),
    model: text(stored.model, 200, fallback.model),
    jsonMode: typeof stored.jsonMode === 'boolean' ? stored.jsonMode : true,
    key: text(stored.key, 500, ''),
  };
}

export async function readAiConfig(): Promise<AiConfig> {
  const raw = await readRaw();
  const storedAi = record(raw.ai) ? raw.ai : {};
  const provider = aiProviderSchema.safeParse(storedAi.provider).success
    ? (storedAi.provider as AiProvider)
    : 'deepseek';
  const storedProfiles = record(storedAi.profiles) ? storedAi.profiles : {};
  const profiles = {} as Record<AiProvider, AiProfile>;
  for (const item of aiProviders) profiles[item] = normalizeProfile(item, storedProfiles[item]);
  // Version 1 stored a single DeepSeek key; keep it without asking again.
  if (!profiles.deepseek.key && typeof raw.deepseekKey === 'string')
    profiles.deepseek.key = raw.deepseekKey.trim().slice(0, 500);
  return { provider, profiles };
}

export function normalizeAiSettings(input: AiSettings): AiSettings {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const model = input.model.trim();
  if (!baseUrl) throw new Error('请填写 AI 接口地址');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('AI 接口地址不是有效的 URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('AI 接口地址只支持 http 或 https');
  if (url.protocol === 'http:' && !localHosts.has(url.hostname))
    throw new Error('非本机地址必须使用 HTTPS，避免 API 密钥明文传输');
  if (url.username || url.password) throw new Error('AI 接口地址不能包含用户名或密码');
  if (url.search || url.hash) throw new Error('AI 接口地址不要包含查询参数或锚点');
  if (!model) throw new Error('请填写模型名称');
  return { provider: input.provider, baseUrl, model, jsonMode: input.jsonMode };
}

export function isProfileCallable(profile: AiProfileSettings) {
  try {
    normalizeAiSettings({ provider: 'custom', ...profile });
    return true;
  } catch {
    return false;
  }
}

async function writeRaw(data: Stored) {
  const target = configPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, target);
  if (process.platform !== 'win32') await fs.chmod(target, 0o600);
}

async function writeConfig(config: AiConfig) {
  const raw = await readRaw();
  const data: Stored = {
    ...raw,
    version: 2,
    ai: { provider: config.provider, profiles: config.profiles },
  };
  // The single-key version is migrated on read; do not keep a duplicate secret.
  delete data.deepseekKey;
  await writeRaw(data);
}

export async function saveAiConfig(input: AiSettings & { key?: string | null }) {
  const settings = normalizeAiSettings(input);
  const config = await readAiConfig();
  const previous = config.profiles[settings.provider];
  const key = input.key === undefined ? previous.key : (input.key ?? '').trim().slice(0, 500);
  config.profiles[settings.provider] = {
    baseUrl: settings.baseUrl,
    model: settings.model,
    jsonMode: settings.jsonMode,
    key,
  };
  config.provider = settings.provider;
  await writeConfig(config);
  return { provider: settings.provider, keySaved: Boolean(key) };
}

export async function activeAi() {
  const config = await readAiConfig();
  const profile = config.profiles[config.provider];
  const envKey = (process.env[aiDefaults[config.provider].env] ?? '').trim().slice(0, 500);
  return { config, profile, key: profile.key || envKey };
}

export async function aiView(): Promise<AiView> {
  const config = await readAiConfig();
  const profiles = {} as Record<AiProvider, AiProfileView>;
  for (const provider of aiProviders) {
    const profile = config.profiles[provider];
    const envKey = (process.env[aiDefaults[provider].env] ?? '').trim();
    const keySaved = Boolean(profile.key);
    const keyConfigured = keySaved || Boolean(envKey);
    profiles[provider] = {
      baseUrl: profile.baseUrl,
      model: profile.model,
      jsonMode: profile.jsonMode,
      keySaved,
      keyFromEnv: !keySaved && Boolean(envKey),
      keyConfigured,
      ready: keyConfigured && isProfileCallable(profile),
    };
  }
  return { provider: config.provider, location: configPath(), profiles };
}

export type QqConfig = {
  enabled: boolean;
  dataDir: string;
  python: string;
  intervalSeconds: number;
  backfillDays: number;
  selfQQ: string;
  key: string;
};

const qqDefaults: QqConfig = {
  enabled: false,
  dataDir: '',
  python: 'py -3.12',
  intervalSeconds: 30,
  backfillDays: 7,
  selfQQ: '',
  key: '',
};

export async function readQqConfig(): Promise<QqConfig> {
  const raw = await readRaw();
  const value = record(raw.qq) ? raw.qq : {};
  const number =
    typeof value.intervalSeconds === 'number' ? value.intervalSeconds : qqDefaults.intervalSeconds;
  const backfill =
    typeof value.backfillDays === 'number' ? value.backfillDays : qqDefaults.backfillDays;
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : qqDefaults.enabled,
    dataDir: text(value.dataDir, 1000, qqDefaults.dataDir),
    python: text(value.python, 200, qqDefaults.python) || qqDefaults.python,
    intervalSeconds: Math.max(10, Math.min(3600, Math.round(number))),
    backfillDays: Math.max(1, Math.min(365, Math.round(backfill))),
    selfQQ: text(value.selfQQ, 20, qqDefaults.selfQQ),
    key: text(value.key, 200, qqDefaults.key),
  };
}

export async function saveQqConfig(
  input: Omit<QqConfig, 'key'> & { key?: string | null },
): Promise<QqConfig> {
  const current = await readQqConfig();
  const config: QqConfig = {
    ...current,
    enabled: Boolean(input.enabled),
    dataDir: input.dataDir.trim().slice(0, 1000),
    python: input.python.trim().slice(0, 200) || qqDefaults.python,
    intervalSeconds: Math.max(10, Math.min(3600, Math.round(input.intervalSeconds))),
    backfillDays: Math.max(1, Math.min(365, Math.round(input.backfillDays))),
    selfQQ: input.selfQQ.trim().replace(/\D/g, '').slice(0, 20),
    key: input.key === undefined ? current.key : (input.key ?? '').trim().slice(0, 200),
  };
  const raw = await readRaw();
  await writeRaw({ ...raw, version: 2, qq: config });
  return config;
}

export async function qqView() {
  const config = await readQqConfig();
  return {
    enabled: config.enabled,
    dataDir: config.dataDir,
    python: config.python,
    intervalSeconds: config.intervalSeconds,
    backfillDays: config.backfillDays,
    selfQQ: config.selfQQ,
    keySaved: Boolean(config.key),
    configured: Boolean(config.key && config.dataDir),
    location: configPath(),
  };
}

export async function activeQq() {
  return readQqConfig();
}
