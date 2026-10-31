import { inboxSchema, emptyInbox, type Inbox } from '../../../../packages/domain/messages';

export const inboxPath = '.atlas/qq-inbox.md';
const start = '<!-- chaos:qq-inbox -->';
const end = '<!-- /chaos:qq-inbox -->';
export function readInboxText(text: string): Inbox {
  if (!text) return emptyInbox();
  const a = text.indexOf(start),
    b = text.indexOf(end);
  if (
    a < 0 ||
    b < a ||
    text.indexOf(start, a + start.length) >= 0 ||
    text.indexOf(end, b + end.length) >= 0
  )
    throw new Error('消息收集文件标记损坏，停止覆盖，请检查 .atlas/qq-inbox.md');
  const block = text
    .slice(a + start.length, b)
    .trim()
    .replaceAll('\r\n', '\n');
  if (!block.startsWith('```json\n') || !block.endsWith('\n```'))
    throw new Error('消息收集文件格式损坏，停止覆盖');
  return inboxSchema.parse(JSON.parse(block.slice(8, -4)));
}
export function writeInboxText(text: string, state: Inbox) {
  readInboxText(text);
  // Escaping < prevents user text from forging the enclosing managed markers.
  const block = `${start}\n\`\`\`json\n${JSON.stringify(inboxSchema.parse(state), null, 2).replaceAll('<', '\\u003c')}\n\`\`\`\n${end}`;
  if (!text) return `# QQ 消息收集\n\n${block}\n`;
  return text.slice(0, text.indexOf(start)) + block + text.slice(text.indexOf(end) + end.length);
}
