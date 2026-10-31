import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  activeAi,
  aiView,
  configPath,
  normalizeAiSettings,
  qqView,
  readAiConfig,
  readQqConfig,
  saveAiConfig,
  saveQqConfig,
} from '../apps/local-service/src/sync/app-config';

let dir = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-config-'));
  process.env.CHAOS_CONFIG_DIR = dir;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CHAOS_AI_API_KEY;
});
afterEach(async () => {
  delete process.env.CHAOS_CONFIG_DIR;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CHAOS_AI_API_KEY;
  await fs.rm(dir, { recursive: true, force: true });
});

const deepseek = {
  provider: 'deepseek' as const,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  jsonMode: true,
};
const openai = {
  provider: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-test',
  jsonMode: true,
};

describe('AI 设置与密钥保存', () => {
  it('默认使用 DeepSeek；密钥写到用户配置目录而不是 Vault', async () => {
    expect(configPath()).toBe(path.join(dir, 'settings.json'));
    const config = await readAiConfig();
    expect(config.provider).toBe('deepseek');
    expect(config.profiles.deepseek).toMatchObject({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      key: '',
    });
    expect(await saveAiConfig({ ...deepseek, key: '  sk-test-123  ' })).toMatchObject({
      provider: 'deepseek',
      keySaved: true,
    });
    expect((await activeAi()).key).toBe('sk-test-123');
    const stored = JSON.parse(await fs.readFile(configPath(), 'utf8'));
    expect(stored).toMatchObject({
      version: 2,
      ai: { provider: 'deepseek', profiles: { deepseek: { key: 'sk-test-123' } } },
    });
    expect(stored.deepseekKey).toBeUndefined();
    if (process.platform !== 'win32') {
      const stat = await fs.stat(configPath());
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('各提供商密钥独立保存；不传密钥时保留，清除只影响当前提供商', async () => {
    await saveAiConfig({ ...deepseek, key: 'sk-ds' });
    await saveAiConfig({ ...openai, key: 'sk-oai' });
    expect((await activeAi()).key).toBe('sk-oai');
    expect((await readAiConfig()).profiles.deepseek.key).toBe('sk-ds');
    // Editing settings without a key must not clear the saved provider key.
    await saveAiConfig({ ...openai, model: 'gpt-test-2' });
    expect((await activeAi()).key).toBe('sk-oai');
    // Clearing OpenAI must not touch the DeepSeek key.
    await saveAiConfig({ ...openai, key: '' });
    const config = await readAiConfig();
    expect(config.profiles.openai.key).toBe('');
    expect(config.profiles.deepseek.key).toBe('sk-ds');
    // Switching back reuses the DeepSeek key, not the OpenAI one.
    await saveAiConfig({ ...deepseek, model: 'deepseek-flash' });
    expect((await activeAi()).key).toBe('sk-ds');
  });

  it('迁移旧版单密钥；状态与接口都不返回密钥本身', async () => {
    await fs.writeFile(configPath(), JSON.stringify({ version: 1, deepseekKey: 'sk-old' }));
    expect((await readAiConfig()).profiles.deepseek.key).toBe('sk-old');
    const view = await aiView();
    expect(view.provider).toBe('deepseek');
    expect(view.profiles.deepseek).toMatchObject({
      keySaved: true,
      keyConfigured: true,
      keyFromEnv: false,
      ready: true,
    });
    expect(JSON.stringify(view)).not.toContain('sk-old');
    await saveAiConfig({ ...deepseek, key: 'sk-new' });
    const stored = JSON.parse(await fs.readFile(configPath(), 'utf8'));
    expect(stored.deepseekKey).toBeUndefined();
    expect(stored.ai.profiles.deepseek.key).toBe('sk-new');
  });

  it('环境变量按提供商后备；本机保存的密钥优先', async () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    let view = await aiView();
    expect(view.profiles.openai).toMatchObject({
      keySaved: false,
      keyFromEnv: true,
      keyConfigured: true,
      ready: false,
    });
    await saveAiConfig(openai);
    view = await aiView();
    expect(view.profiles.openai).toMatchObject({ ready: true, keyFromEnv: true });
    expect((await activeAi()).key).toBe('sk-env');
    await saveAiConfig({ ...openai, key: 'sk-saved' });
    expect((await activeAi()).key).toBe('sk-saved');
    await saveAiConfig({ ...openai, key: '' });
    expect((await activeAi()).key).toBe('sk-env');
  });

  it('接口地址只允许 HTTPS 或本机 HTTP，模型必填', () => {
    const base = { provider: 'custom' as const, model: 'm', jsonMode: true };
    expect(() => normalizeAiSettings({ ...base, baseUrl: '' })).toThrow('接口地址');
    expect(() => normalizeAiSettings({ ...base, baseUrl: 'ftp://x.test' })).toThrow('http');
    expect(() => normalizeAiSettings({ ...base, baseUrl: 'http://example.com' })).toThrow('HTTPS');
    expect(() =>
      normalizeAiSettings({ ...base, baseUrl: 'https://user:pass@example.com' }),
    ).toThrow('用户名');
    expect(() => normalizeAiSettings({ ...base, baseUrl: 'https://x.test/v1?token=1' })).toThrow(
      '查询参数',
    );
    expect(() => normalizeAiSettings({ ...base, baseUrl: 'https://x.test/v1', model: '' })).toThrow(
      '模型',
    );
    expect(() =>
      normalizeAiSettings({ ...base, baseUrl: 'http://127.0.0.1:11434/v1' }),
    ).not.toThrow();
    expect(
      normalizeAiSettings({
        ...base,
        baseUrl: 'https://x.test/v1/',
        model: ' m ',
        jsonMode: false,
      }),
    ).toEqual({ provider: 'custom', baseUrl: 'https://x.test/v1', model: 'm', jsonMode: false });
  });

  it('配置文件损坏时按默认处理，保存后恢复为有效 JSON', async () => {
    await fs.writeFile(configPath(), '{broken');
    expect((await readAiConfig()).provider).toBe('deepseek');
    expect((await activeAi()).key).toBe('');
    await saveAiConfig({ ...deepseek, key: 'sk-repaired' });
    expect((await activeAi()).key).toBe('sk-repaired');
    expect(JSON.parse(await fs.readFile(configPath(), 'utf8')).ai.profiles.deepseek.key).toBe(
      'sk-repaired',
    );
  });

  it('QQ 同步设置与密钥保存，状态不返回密钥', async () => {
    expect(await readQqConfig()).toMatchObject({
      enabled: false,
      python: 'py -3.12',
      intervalSeconds: 30,
    });
    await saveQqConfig({
      enabled: true,
      dataDir: 'D:\\qq-data',
      python: 'py -3.12',
      intervalSeconds: 45,
      backfillDays: 7,
      selfQQ: '123456',
      key: 'abcdefghijklmnop',
    });
    expect(await readQqConfig()).toMatchObject({
      enabled: true,
      dataDir: 'D:\\qq-data',
      intervalSeconds: 45,
      backfillDays: 7,
      selfQQ: '123456',
      key: 'abcdefghijklmnop',
    });
    // Omitting key edits settings without clearing the saved key.
    await saveQqConfig({
      enabled: true,
      dataDir: 'D:\\qq-data-2',
      python: 'py -3.12',
      intervalSeconds: 60,
      backfillDays: 7,
      selfQQ: '123456',
    });
    expect((await readQqConfig()).key).toBe('abcdefghijklmnop');
    const view = await qqView();
    expect(view).toMatchObject({ configured: true, keySaved: true });
    expect(JSON.stringify(view)).not.toContain('abcdefghijklmnop');
    await saveQqConfig({
      enabled: true,
      dataDir: 'D:\\qq-data-2',
      python: 'py -3.12',
      intervalSeconds: 60,
      backfillDays: 7,
      selfQQ: '123456',
      key: '',
    });
    expect((await readQqConfig()).key).toBe('');
    expect((await qqView()).configured).toBe(false);
  });
});
