import type { Milestone, Todo, NoteComment } from '../domain/index';

type SectionKind = 'node' | 'item' | 'comment';
const marker = (kind: SectionKind, id: string, end = false) =>
  `<!-- ${end ? '/' : ''}atlas:${kind} ${id} -->`;
const headingText = (text: string) =>
  text
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

export function section(body: string, kind: SectionKind, id: string) {
  const start = marker(kind, id),
    end = marker(kind, id, true);
  const from = body.indexOf(start),
    to = body.indexOf(end);
  if (from < 0 && to < 0) return null;
  if (
    from < 0 ||
    to < from ||
    body.indexOf(start, from + start.length) >= 0 ||
    body.indexOf(end, to + end.length) >= 0
  )
    throw new Error('Notes 段落标记损坏，请先检查正文，未覆盖内容');
  return { from, to: to + end.length, text: body.slice(from + start.length, to).trim() };
}

export function putSection(body: string, kind: SectionKind, id: string, text: string | null) {
  const found = section(body, kind, id);
  const replacement =
    text === null ? '' : `${marker(kind, id)}\n${text.trim()}\n${marker(kind, id, true)}`;
  return found
    ? body.slice(0, found.from) + replacement + body.slice(found.to)
    : `${body.trimEnd()}\n\n${replacement}\n`;
}

export function nodeHeading(node: Milestone) {
  return `## ${node.dueDate ?? '未定日期'}${node.dueTime ? ' ' + node.dueTime : ''} · ${headingText(node.title)}`;
}
export const itemHeading = (item: Todo) =>
  `### ${item.kind === 'idea' ? 'IDEA' : 'TODO'} · ${headingText(item.title)}`;

export function appendComment(
  body: string,
  node: Milestone,
  item: Todo | undefined,
  comment: { id: string; text: string; date: string },
) {
  const commentStart = `<!-- atlas:comment ${comment.id} -->`;
  if (body.includes(commentStart)) {
    const end = body.indexOf(`<!-- /atlas:comment ${comment.id} -->`, body.indexOf(commentStart));
    if (
      end < 0 ||
      body
        .slice(body.indexOf(commentStart) + commentStart.length, end)
        .trim()
        .replaceAll('\r\n', '\n') !==
        `${comment.date}\n\n${comment.text.trim().replaceAll('\r\n', '\n')}`
    )
      throw new Error('该批注已存在且内容不同，请重新加载，原文未覆盖');
    return body;
  }
  const block = `${commentStart}\n${comment.date}\n\n${comment.text.trim()}\n<!-- /atlas:comment ${comment.id} -->`;
  let nodeText = section(body, 'node', node.id)?.text ?? nodeHeading(node);
  nodeText = nodeText.replace(/^##[^\r\n]*/, nodeHeading(node));
  if (item) {
    let itemText = section(nodeText, 'item', item.id)?.text ?? itemHeading(item);
    itemText = itemText.replace(/^###[^\r\n]*/, itemHeading(item));
    nodeText = putSection(nodeText, 'item', item.id, itemText + '\n\n' + block);
  } else {
    const children = nodeText.indexOf('<!-- atlas:item ');
    nodeText =
      children < 0
        ? nodeText.trimEnd() + '\n\n' + block
        : nodeText.slice(0, children).trimEnd() +
          '\n\n' +
          block +
          '\n\n' +
          nodeText.slice(children);
  }
  return putSection(body, 'node', node.id, nodeText);
}

export function refreshHeadings(body: string, node: Milestone, item?: Todo) {
  const found = section(body, 'node', node.id);
  if (!found) return body;
  let text = found.text.replace(/^##[^\r\n]*/, nodeHeading(node));
  if (item) {
    const child = section(text, 'item', item.id);
    if (child)
      text = putSection(
        text,
        'item',
        item.id,
        child.text.replace(/^###[^\r\n]*/, itemHeading(item)),
      );
  }
  return putSection(body, 'node', node.id, text);
}

export function unbindSections(body: string, ids: Set<string>) {
  for (const id of ids)
    for (const kind of ['item', 'node'] as const) {
      const found = section(body, kind, id);
      if (found) body = body.slice(0, found.from) + found.text + body.slice(found.to);
    }
  return body;
}

export const displayNotes = (body: string) =>
  body.replace(/<!--\s*\/?atlas:[\s\S]*?-->/g, '').trim();

const trimBlankLines = (text: string) => text.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, '');
function contentParts(text: string, heading: string) {
  const first = /^[^\r\n]*(?:\r?\n|$)/.exec(text)?.[0] ?? '';
  let own = first.trimEnd() === heading ? text.slice(first.length) : text;
  const children: string[] = [];
  for (const match of [...own.matchAll(/<!-- atlas:item ([a-f0-9-]{36}) -->/g)]) {
    const child = section(own, 'item', match[1]);
    if (!child) throw new Error('Notes 子项标记损坏');
    children.push(own.slice(child.from, child.to));
    own = own.slice(0, child.from) + own.slice(child.to);
  }
  const comments: NoteComment[] = [];
  for (const match of [...own.matchAll(/<!-- atlas:comment ([a-f0-9-]{36}) -->/g)]) {
    const comment = section(own, 'comment', match[1]);
    if (!comment) throw new Error('Notes 批注标记损坏');
    const split = /^(\d{4}-\d{2}-\d{2})(?:\r?\n|$)([\s\S]*)$/.exec(comment.text);
    if (!split) throw new Error('Notes 批注日期损坏');
    comments.push({ id: match[1], date: split[1], text: trimBlankLines(split[2]) });
    own = own.slice(0, comment.from) + own.slice(comment.to);
  }
  if (/<!--\s*\/?atlas:/.test(own)) throw new Error('Notes 内容标记损坏');
  return { body: trimBlankLines(own), comments, children };
}

export function editableSection(body: string, item: Milestone | Todo) {
  const found = section(body, item.type === 'todo' ? 'item' : 'node', item.id);
  return contentParts(
    found?.text ?? '',
    item.type === 'todo' ? itemHeading(item) : nodeHeading(item),
  );
}

export function replaceContent(
  body: string,
  node: Milestone,
  item: Todo | undefined,
  text: string,
  edits?: { id: string; text: string }[],
) {
  if (/<!--\s*\/?atlas:/i.test(text) || edits?.some((edit) => /<!--\s*\/?atlas:/i.test(edit.text)))
    throw new Error('只能编辑内部正文，不能提交系统结构标记');
  const current = editableSection(body, item ?? node);
  const originals = new Map(current.comments.map((comment) => [comment.id, comment]));
  if (
    edits &&
    (new Set(edits.map((edit) => edit.id)).size !== edits.length ||
      edits.some((edit) => !originals.has(edit.id)))
  )
    throw new Error('批注不属于当前节点或条目，未覆盖内容');
  const changes = new Map(edits?.map((edit) => [edit.id, edit.text]));
  const comments = current.comments.map(
    (comment) =>
      `${marker('comment', comment.id)}\n${comment.date}\n\n${trimBlankLines(changes.get(comment.id) ?? comment.text)}\n${marker('comment', comment.id, true)}`,
  );
  const updated = [
    item ? itemHeading(item) : nodeHeading(node),
    trimBlankLines(text),
    ...comments,
    ...current.children,
  ]
    .filter(Boolean)
    .join('\n\n');
  if (!item) return putSection(body, 'node', node.id, updated);
  const parent = section(body, 'node', node.id)?.text ?? nodeHeading(node);
  return putSection(body, 'node', node.id, putSection(parent, 'item', item.id, updated));
}
