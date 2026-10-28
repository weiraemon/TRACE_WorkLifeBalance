import { afterEach, expect, it, vi } from 'vitest';
import { readLastVault, rememberVault } from '../apps/web/src/lastVault';
afterEach(() => vi.unstubAllGlobals());
it('remembers the last successful directory across reads', () => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
  expect(readLastVault()).toBe('');
  rememberVault('D:\\Work Notes');
  expect(readLastVault()).toBe('D:\\Work Notes');
});
it('still works when browser storage is unavailable', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('disabled');
    },
    setItem: () => {
      throw new Error('disabled');
    },
  });
  expect(readLastVault()).toBe('');
  expect(() => rememberVault('D:\\Notes')).not.toThrow();
});
