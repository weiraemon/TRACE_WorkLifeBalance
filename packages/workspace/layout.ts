export const layoutPath = 'ATLAS/layout.json';
export const layoutSource = JSON.stringify({ version: 1, records: 'ATLAS/records' });
export function recordPath(id: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error('无效记录 ID');
  const name = id.toLowerCase();
  return `ATLAS/records/${name.slice(0, 2)}/${name}.md`;
}
export function validLayout(source: string) {
  const value = JSON.parse(source);
  if (value.version !== 1 || value.records !== 'ATLAS/records')
    throw new Error('工作目录布局版本不支持，停止写入');
}

export function checkRelocationLinks(source: string, path: string, moves: Map<string, string>) {
  for (const match of source.matchAll(/\[\[([^\]\n]+)\]\]|\]\(([^)\n]+)\)/g)) {
    const wiki = match[1] !== undefined;
    const raw = (match[1] ?? match[2]).split('|')[0].replace(/^<|>$/g, '').split('#')[0].trim();
    if (!raw || /^[a-z]+:/i.test(raw)) continue;
    const parts = (
      wiki || raw.startsWith('/') ? raw : path.slice(0, path.lastIndexOf('/') + 1) + raw
    )
      .replace(/^\//, '')
      .split('/');
    const normalized: string[] = [];
    for (const part of parts) {
      if (part === '..') normalized.pop();
      else if (part && part !== '.') normalized.push(part);
    }
    const target = normalized.join('/');
    const old = moves.has(target) ? target : moves.has(target + '.md') ? target + '.md' : undefined;
    const renamedWiki =
      wiki &&
      !raw.includes('/') &&
      [...moves].some(
        ([from, to]) =>
          from.split('/').at(-1)?.replace(/\.md$/i, '') === raw &&
          to.split('/').at(-1)?.replace(/\.md$/i, '') !== raw,
      );
    if (old || renamedWiki)
      throw new Error(`正文含有依赖旧文件位置的手工链接，请先整理该链接后重试：${path}`);
  }
}
