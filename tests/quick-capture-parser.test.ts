import { describe, expect, test } from 'vitest';
import { parseRecord, type Entry } from '../packages/domain';
import { parseQuickCapture } from '../apps/web/src/features/quickCaptureParser';

const now = '2026-10-26T08:00:00.000Z';
function entry(data: object): Entry {
  return {
    data: parseRecord({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...data,
    }),
    path: '',
    revision: '',
  };
}
function workspace() {
  const project = entry({ type: 'project', title: '科研项目' });
  const line = entry({
    type: 'workline',
    title: '论文研究',
    projectId: project.data.id,
    notesId: crypto.randomUUID(),
  });
  const pool = entry({ type: 'milestone', title: '待办池', lineId: line.data.id, pool: true });
  return { entries: [project, line, pool], line };
}

describe('快速生成文字解析', () => {
  test('识别明天、中文半点、标签和业务线', () => {
    const { entries, line } = workspace();
    const result = parseQuickCapture(
      ' @航宇\u2005 @。···\u2005 明天上午九点半论文讨论下推进方案',
      entries,
      '2026-10-26',
    );
    expect(result).toMatchObject({
      dueDate: '2026-10-27',
      dueTime: '09:30',
      importance: 3,
      tags: ['会议'],
      lineId: line.data.id,
    });
    expect(result.title).toContain('推进方案');
  });

  test('识别 9 点、9.、周二和下周二', () => {
    expect(parseQuickCapture('9点开会', [], '2026-10-26')).toMatchObject({
      dueDate: '2026-10-26',
      dueTime: '09:00',
    });
    expect(parseQuickCapture('周二9. 方案讨论', [], '2026-10-26')).toMatchObject({
      dueDate: '2026-10-27',
      dueTime: '09:00',
    });
    expect(parseQuickCapture('下周二下午1点半 例会', [], '2026-10-26')).toMatchObject({
      dueDate: '2026-11-03',
      dueTime: '13:30',
    });
    expect(parseQuickCapture('下周例会，周一下午1点半，线下301', [], '2026-10-26')).toMatchObject({
      dueDate: '2026-11-02',
      dueTime: '13:30',
    });
  });

  test('没有可靠匹配时业务线保持空白', () => {
    const { entries } = workspace();
    expect(
      parseQuickCapture('周末测完哪些了，还剩哪些没测的', entries, '2026-10-26'),
    ).toMatchObject({
      dueDate: '2026-10-31',
      dueTime: null,
      lineId: '',
      tags: ['实验'],
    });
  });
});
