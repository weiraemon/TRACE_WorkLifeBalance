import type { Milestone, Todo } from '../../../packages/domain/index';

type SectionKind = 'node' | 'item';
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
