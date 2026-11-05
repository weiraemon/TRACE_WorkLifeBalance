import { parseDocument, stringify, isMap } from 'yaml';
import { parseRecord, type RecordData } from '../domain/index';
import { VaultError } from './errors';

export const frontmatter = /^(\uFEFF?---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/m;

// Replace only our top-level YAML value; other keys, comments and body remain byte-for-byte intact.
export function decodeNote(source: string) {
  const match = frontmatter.exec(source);
  if (!match || match.index !== 0) {
    if (/^\uFEFF?---(?:\r?\n|$)/.test(source)) throw new VaultError('Frontmatter 未闭合');
    return null;
  }
  if (!match[2].trim()) return null;
  const document = parseDocument(match[2], { uniqueKeys: true });
  if (document.errors.length || !isMap(document.contents))
    throw new VaultError('非法 Frontmatter：' + (document.errors[0]?.message ?? '必须为映射'));
  const atlas = document.get('atlas', true);
  if (!atlas) return null;
  const object = document.toJS({ maxAliasCount: 20 });
  if (!object.atlas || object.atlas.managed !== true) return null;
  return { data: parseRecord(object.atlas.record), match, document };
}
export function updateNote(source: string, data: RecordData) {
  const note = decodeNote(source);
  if (!note) throw new VaultError('该文件不属于 ATLAS，拒绝修改');
  const pair = (note.document.contents as import('yaml').YAMLMap).items.find(
    (p) => String(p.key) === 'atlas',
  );
  const range = (pair?.value as import('yaml').Node | undefined)?.range;
  if (!range) throw new VaultError('无法安全定位 ATLAS 字段');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const replacement =
    newline +
    stringify({ managed: true, record: data })
      .trimEnd()
      .split('\n')
      .map((line) => '  ' + line)
      .join(newline) +
    newline;
  const yaml = note.match[2];
  return (
    note.match[1] +
    yaml.slice(0, range[0]).trimEnd() +
    replacement +
    yaml.slice(range[2]) +
    source.slice(note.match[1].length + yaml.length)
  );
}
export const newNote = (data: RecordData) =>
  `---\n${stringify({ atlas: { managed: true, record: data } })}---\n\n# ${'title' in data ? data.title : 'ATLAS ' + data.type}\n\n`;

export function localizeNote(source: string, path: string) {
  const note = decodeNote(source);
  return note?.data.type === 'resource' &&
    note.data.noteId === note.data.id &&
    note.data.target !== path
    ? updateNote(source, { ...note.data, target: path })
    : source;
}
