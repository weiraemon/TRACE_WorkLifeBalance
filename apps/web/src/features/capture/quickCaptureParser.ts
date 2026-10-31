import { activeLines } from '../../../../../packages/domain/workspace';
import { localDay, type Entry } from '../../../../../packages/domain/index';

export type ParsedQuickCapture = {
  title: string;
  dueDate: string | null;
  dueTime: string | null;
  importance: number;
  tags: string[];
  lineId: string;
};

const weekday: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const digit: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function chineseNumber(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  if (value.includes('十')) {
    const [tens, units] = value.split('十');
    return (tens ? digit[tens] * 10 : 10) + (units ? digit[units] : 0);
  }
  return digit[value] ?? Number.NaN;
}

function addDays(value: string, days: number) {
  const date = new Date(value + 'T12:00:00');
  date.setDate(date.getDate() + days);
  return localDay(date);
}

function parseDate(text: string, today: string) {
  if (/后天/.test(text)) return addDays(today, 2);
  if (/明天/.test(text)) return addDays(today, 1);
  if (/今天|今日/.test(text)) return today;
  const monthDay = text.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)/);
  if (monthDay) {
    const year = Number(monthDay[1] ?? today.slice(0, 4));
    const month = Number(monthDay[2]);
    const day = Number(monthDay[3]);
    const lastDay = new Date(year, month, 0).getDate();
    if (month >= 1 && month <= 12 && day >= 1 && day <= lastDay)
      return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const nextWeekday = text.match(
    /下周(?:[^一二三四五六日天]{0,12})?(?:周|星期)?\s*([一二三四五六日天])/,
  );
  if (nextWeekday) {
    const target = weekday[nextWeekday[1]];
    const current = new Date(today + 'T12:00:00').getDay();
    return addDays(today, 7 + ((target - current + 7) % 7));
  }
  const week = text.match(/(?:本周|这周|周|星期)\s*([一二三四五六日天])/);
  if (week) {
    const target = weekday[week[1]];
    const current = new Date(today + 'T12:00:00').getDay();
    return addDays(today, (target - current + 7) % 7);
  }
  if (/周末|本周末/.test(text)) {
    const current = new Date(today + 'T12:00:00').getDay();
    return addDays(today, (6 - current + 7) % 7);
  }
  return null;
}

function parseTime(text: string) {
  const match = text.match(
    /(上午|早上|中午|下午|晚上)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:点|[.．:])(?:半|\s*([0-5]?\d)\s*分?)?/,
  );
  if (!match) return null;
  let hour = chineseNumber(match[2]);
  if (!Number.isFinite(hour) || hour > 23) return null;
  const period = match[1] ?? '';
  if ((period === '下午' || period === '晚上') && hour < 12) hour += 12;
  if (period === '中午' && hour < 11) hour += 12;
  const minute = match[0].includes('半') ? 30 : Number(match[3] ?? 0);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function withoutMentions(text: string) {
  return text.replace(/@[^\s\u2000-\u200f]+[\s\u2000-\u200f]*/g, ' ');
}

function cleanTitle(text: string) {
  return text
    .replace(
      /(下周\s*[一二三四五六日天]|(?:本周|这周|周|星期)\s*[一二三四五六日天]|周末|本周末|明天|后天|今天|今日)/g,
      ' ',
    )
    .replace(/(?:\d{4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*(?:日|号)/g, ' ')
    .replace(/下周/g, ' ')
    .replace(
      /(上午|早上|中午|下午|晚上)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:点|[.．:])(?:半|\s*[0-5]?\d\s*分?)?/g,
      ' ',
    )
    .replace(/[，,、。；;]+/g, '，')
    .replace(/^\s*，|，\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value: string) {
  const result = new Set<string>();
  for (const segment of value.match(/[\p{Script=Han}A-Za-z0-9]+/gu) ?? []) {
    if (segment.length >= 2) result.add(segment);
    if (/^[\p{Script=Han}]+$/u.test(segment))
      for (let i = 0; i < segment.length - 1; i++) result.add(segment.slice(i, i + 2));
  }
  return [...result];
}

function matchLine(text: string, entries: Entry[]) {
  const lines = activeLines(entries);
  const projects = new Map(
    entries.flatMap((e) => (e.data.type === 'project' ? [[e.data.id, e.data.title] as const] : [])),
  );
  const lineCountByProject = new Map<string, number>();
  for (const line of lines)
    lineCountByProject.set(line.projectId, (lineCountByProject.get(line.projectId) ?? 0) + 1);
  const ranked = lines
    .map((line) => {
      const projectTitle = projects.get(line.projectId) ?? '';
      const lineTokens = tokens(line.title);
      const projectTokens =
        lineCountByProject.get(line.projectId) === 1 ? tokens(projectTitle) : [];
      const score =
        lineTokens.reduce((sum, token) => sum + (text.includes(token) ? token.length * 3 : 0), 0) +
        projectTokens.reduce((sum, token) => sum + (text.includes(token) ? token.length : 0), 0);
      return { line, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked[1] && ranked[0].score === ranked[1].score)) return '';
  return ranked[0].line.id;
}

export function parseQuickCapture(
  input: string,
  entries: Entry[],
  today = localDay(),
): ParsedQuickCapture {
  const text = withoutMentions(input).replace(/\s+/g, ' ').trim();
  const dueTime = parseTime(text);
  // A time without a day is the user's next same-day reminder.
  const dueDate = parseDate(text, today) ?? (dueTime ? today : null);
  const tags = /例会|会议|开会|讨论/.test(text)
    ? ['会议']
    : /实验|测试|测完|测没/.test(text)
      ? ['实验']
      : /报告|计划|发布|发我/.test(text)
        ? ['报告']
        : [];
  const importance = /紧急|尽快|必须|立刻|截止|今天|今日|关键/.test(text)
    ? 5
    : /重要|例会|推进|讨论|计划|发我/.test(text)
      ? 3
      : 1;
  return {
    title: cleanTitle(text) || text,
    dueDate,
    dueTime: dueDate ? dueTime : null,
    importance,
    tags,
    lineId: matchLine(text, entries),
  };
}
