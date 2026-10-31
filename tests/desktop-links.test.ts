import { expect, it } from 'vitest';
import { externalLink } from '../apps/desktop/links';

it('桌面资源链接保留网页与指定笔记的 Obsidian 打开，拒绝其他协议和命令', () => {
  expect(externalLink('https://example.com/notes')).toBe('https://example.com/notes');
  expect(externalLink('obsidian://open?path=E%3A%5CNotes%5Cwork.md')).toBeDefined();
  for (const value of [
    'file:///C:/Windows/System32/cmd.exe',
    'javascript:alert(1)',
    'powershell:run',
    'obsidian://advanced-uri?commandname=anything',
    'obsidian://open?path=note.md&command=run',
    'invalid',
  ]) {
    expect(externalLink(value)).toBeUndefined();
  }
});
