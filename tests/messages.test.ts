import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  emptyInbox,
  fallbackDestination,
  inboxSchema,
  matchMessage,
  messageSettingsSchema,
  suggestionSchema,
  type SourceMessage,
} from '../packages/domain/messages';
import {
  analyzeMessage,
  chatEndpoint,
  dropNoopChanges,
  mergeSameTitle,
  messageFingerprint,
  parseSuggestions,
} from '../apps/local-service/src/sync/message-analysis';
import { readInboxText, writeInboxText } from '../apps/local-service/src/sync/message-store';

const id = randomUUID();
const state = emptyInbox();
state.settings.names = ['张三'];
state.settings.classes = ['软件一班'];
state.settings.rules.push({
  id,
  name: '年级通知',
  kind: 'group',
  enabled: true,
  useAi: true,
  autoAccept: false,
  includeSelf: false,
  mode: 'conditions',
  conditions: ['atAll', 'atMe', 'name', 'class'],
  senders: [],
  keywords: [],
  aliases: [],
  projectId: null,
  chatId: null,
  lineId: null,
});
const message: SourceMessage = {
  ruleId: id,
  sender: '老师',
  sentAt: '2026-10-28T08:00:00+08:00',
  text: '请提交材料',
  context: '',
  atAll: false,
  atMe: false,
  remoteId: null,
  fromSelf: false,
};
const suggestion = {
  kind: 'task',
  title: '提交材料',
  dueDate: '2026-10-30',
  dueTime: null,
  reason: '要求交材料',
  uncertainty: '',
  actions: ['提交材料'],
};
describe('QQ 筛选与模型边界', () => {
  it('旧会话规则缺少限定项目、QQ 群号或自动开关时按未设置处理', () => {
    const rule = { ...state.settings.rules[0] } as Record<string, unknown>;
    delete rule.projectId;
    delete rule.chatId;
    delete rule.autoAccept;
    delete rule.includeSelf;
    const parsed = messageSettingsSchema.parse({ ...state.settings, rules: [rule] });
    expect(parsed.rules[0].projectId).toBeNull();
    expect(parsed.rules[0].chatId).toBeNull();
    expect(parsed.rules[0].autoAccept).toBe(false);
    expect(parsed.rules[0].includeSelf).toBe(false);
  });
  it('旧收集箱缺少同步游标时按空游标读取', () => {
    const old = { ...state, sync: undefined };
    expect(inboxSchema.parse(old).sync).toEqual([]);
  });
  it('开启同步本人消息后，条件模式也直接检查本人消息', () => {
    const selfMessage = { ...message, fromSelf: true };
    expect(matchMessage(state.settings, selfMessage)).toBe(false);
    const inclusive = {
      ...state.settings,
      rules: state.settings.rules.map((rule) => ({ ...rule, includeSelf: true })),
    };
    expect(matchMessage(inclusive, selfMessage)).toBe(true);
    expect(matchMessage(inclusive, message)).toBe(false);
  });
  it('只有选择且启用的会话进入筛选，真实 @ 与正文分开', () => {
    expect(matchMessage(state.settings, message)).toBe(false);
    expect(matchMessage(state.settings, { ...message, text: '@全体成员 这只是文本' })).toBe(false);
    for (const patch of [
      { atAll: true },
      { atMe: true },
      { text: '张三请提交' },
      { text: '软件一班请提交' },
    ])
      expect(matchMessage(state.settings, { ...message, ...patch })).toBe(true);
    expect(matchMessage(state.settings, { ...message, ruleId: randomUUID(), atAll: true })).toBe(
      false,
    );
    const paused = structuredClone(state.settings);
    paused.rules[0].enabled = false;
    expect(matchMessage(paused, { ...message, atAll: true })).toBe(false);
  });
  it('私聊、全量模式和发送人条件可独立使用', () => {
    const settings = structuredClone(state.settings);
    Object.assign(settings.rules[0], { kind: 'private', mode: 'all' });
    expect(matchMessage(settings, message)).toBe(true);
    Object.assign(settings.rules[0], {
      mode: 'conditions',
      conditions: ['sender'],
      senders: ['老师'],
    });
    expect(matchMessage(settings, message)).toBe(true);
    expect(matchMessage(settings, { ...message, sender: '同学' })).toBe(false);
  });
  it('私聊收到的消息按 atMe 命中，自己发出的消息不冒充对方', () => {
    const settings = structuredClone(state.settings);
    Object.assign(settings.rules[0], {
      kind: 'private',
      mode: 'conditions',
      conditions: ['atMe'],
    });
    expect(matchMessage(settings, { ...message, atMe: true, fromSelf: false })).toBe(true);
    expect(matchMessage(settings, { ...message, atMe: false, fromSelf: true })).toBe(false);
  });
  it('去重标识包括会话、发送人、发送时间和 QQ 消息 ID', () => {
    expect(messageFingerprint(message)).toBe(messageFingerprint({ ...message }));
    expect(messageFingerprint(message)).not.toBe(
      messageFingerprint({ ...message, ruleId: randomUUID() }),
    );
    expect(messageFingerprint(message)).not.toBe(
      messageFingerprint({ ...message, remoteId: '123' }),
    );
  });
  it('同一消息中的同名建议合并为一项，保留行动和其他时间提示', () => {
    const merged = mergeSameTitle([
      {
        ...suggestion,
        kind: 'task',
        targetId: null,
        completed: false,
        title: '选民投票志愿者',
        dueDate: '2026-10-30',
        dueTime: '18:00',
        actions: ['参加培训'],
        tags: ['会议'],
        location: 'A02 公寓',
      },
      {
        ...suggestion,
        kind: 'task',
        targetId: null,
        completed: false,
        title: '选民投票志愿者 ',
        dueDate: '2026-10-31',
        dueTime: '06:50',
        actions: ['上午值班'],
        tags: ['会议'],
        location: null,
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].actions).toEqual(['参加培训', '上午值班']);
    expect(merged[0].tags).toEqual(['会议']);
    expect(merged[0].uncertainty).toContain('其他时间');
    expect(merged[0].uncertainty).toContain('2026-10-31 06:50');
  });
  it('同一消息中节点与子待办的同名变更合并为节点变更', () => {
    const existing = [
      {
        id: randomUUID(),
        type: 'milestone' as const,
        title: '紫丁香三号出厂评审',
        dueDate: '2026-10-30',
        dueTime: '10:00',
        lineTitle: '评审',
      },
      {
        id: randomUUID(),
        type: 'todo' as const,
        title: '完成紫丁香三号出厂评审',
        dueDate: null,
        dueTime: null,
        lineTitle: '评审',
      },
    ];
    const merged = mergeSameTitle(
      [
        {
          ...suggestion,
          kind: 'change',
          targetId: existing[0].id,
          completed: false,
          dueDate: '2026-11-02',
          dueTime: '15:00',
          title: '紫丁香三号出厂评审',
          actions: [],
          tags: ['审阅'],
          location: null,
        },
        {
          ...suggestion,
          kind: 'change',
          targetId: existing[1].id,
          completed: false,
          dueDate: '2026-11-02',
          dueTime: '15:00',
          title: '完成紫丁香三号出厂评审',
          actions: [],
          tags: [],
          location: null,
        },
      ],
      existing,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].targetId).toBe(existing[0].id);
    expect(merged[0].uncertainty).toContain('同名变更已合并');
  });
  it('日期、时刻和地点都相同的重复 change 被丢弃', () => {
    const target = {
      id: randomUUID(),
      type: 'milestone' as const,
      title: '去卫星所测试紫丁香三号上注程序',
      dueDate: '2026-10-31',
      dueTime: '09:00',
      location: '卫星所',
      lineTitle: '测试',
    };
    const same = {
      ...suggestion,
      kind: 'change' as const,
      targetId: target.id,
      completed: false,
      dueDate: '2026-10-31',
      dueTime: '09:00',
      location: '卫星所',
      tags: [],
    };
    const changed = { ...same, dueDate: '2026-11-01' };
    expect(dropNoopChanges([same, changed], [target])).toEqual([changed]);
  });
  it('拒绝非法日期以及没有日期的时刻', () => {
    expect(() => suggestionSchema.parse({ ...suggestion, dueDate: '2026-02-30' })).toThrow();
    expect(() =>
      suggestionSchema.parse({ ...suggestion, dueDate: null, dueTime: '09:00' }),
    ).toThrow();
  });
  it('只发必要字段；模型输出经校验，截断、空响应和服务错误不产生事项', async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(suggestion) } }],
        }),
      ),
    );
    expect(await analyzeMessage(message, state.settings, 'secret-for-test', request)).toMatchObject(
      [
        {
          kind: 'task',
          title: '提交材料',
          dueDate: '2026-10-30',
          dueTime: null,
          reason: '要求交材料',
          destination: expect.objectContaining({ kind: 'newProject' }),
        },
      ],
    );
    const payload = JSON.parse(request.mock.calls[0][1].body);
    expect(payload.messages[0].content).toContain('不可信数据');
    expect(payload.messages[1].content).not.toContain('secret-for-test');
    expect(payload.messages[1].content).not.toContain('年级通知');
    for (const [value, expected] of [
      ['', '空内容'],
      ['{}', '字段格式错误'],
      ['{bad', 'JSON 格式'],
    ]) {
      request.mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: value } }] }),
        ),
      );
      await expect(analyzeMessage(message, state.settings, 'key', request)).rejects.toThrow(
        expected,
      );
    }
    request.mockResolvedValue(new Response('secret provider error', { status: 401 }));
    await expect(analyzeMessage(message, state.settings, 'key', request)).rejects.toThrow('401');
  });
  it('课程通知缺少具体时间或可选字段时仍生成待核对事项', () => {
    const result = parseSuggestions(
      JSON.stringify({
        suggestions: [
          {
            kind: 'task',
            title: '核对数值分析课表',
            dueDate: '第10周',
            dueTime: '未说明',
            reason: '2027级推免生第10周开始上课，11月2日为第10周',
          },
        ],
      }),
    );
    expect(result[0]).toMatchObject({ dueDate: null, dueTime: null, actions: [] });
    expect(result[0].uncertainty).toContain('请核对原文');
    expect(
      parseSuggestions(JSON.stringify({ ...suggestion, dueDate: '', dueTime: '' }))[0],
    ).toMatchObject({ dueDate: null, dueTime: null });
  });
  it('宣介会和报名截止分别保留日期、时刻和行动，不互相覆盖', async () => {
    const items = [
      {
        ...suggestion,
        kind: 'event',
        title: '寒期项目宣介会',
        dueDate: '2026-10-29',
        dueTime: '18：30',
        reason: '地点：示例楼 101',
        actions: [],
      },
      { ...suggestion, title: '寒期项目报名截止', dueDate: '2026-11-02', dueTime: '18:00' },
    ];
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify({ suggestions: items }) },
            },
          ],
        }),
      ),
    );
    const result = await analyzeMessage(
      {
        ...message,
        text: '@全体成员 示例学院2027寒期项目申报通知\n项目说明会：2026年10月29日（周四）晚18：30，地点：示例楼101。\n申报者请于2026年11月2日（周一）18：00前填写报名链接：https://example.com/apply',
      },
      state.settings,
      'test',
      request,
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ dueDate: '2026-10-29', dueTime: '18:30' });
    expect(result[1]).toMatchObject({ dueDate: '2026-11-02', dueTime: '18:00' });
  });
  it('不推算缺失日期、无效日期和未知时刻，缺失理由明确提示', () => {
    const result = parseSuggestions(
      JSON.stringify({ ...suggestion, dueDate: '2026-02-30', dueTime: '9:00', reason: null }),
    )[0];
    expect(result).toMatchObject({ dueDate: null, dueTime: null });
    expect(result.uncertainty).toContain('缺少判断依据');
    expect(result.uncertainty).toContain('缺少确定日期');
    expect(parseSuggestions(JSON.stringify({ kind: 'ignore' }))[0]).toMatchObject({
      kind: 'ignore',
      title: '无需安排',
      actions: [],
      dueDate: null,
      dueTime: null,
    });
  });
  it('截断、空结果、格式错误分别提示，部分无效结果整批拒绝且不泄漏原文', async () => {
    for (const [value, expected] of [
      [{ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }, '长度上限'],
      [{ choices: [] }, '缺少结果'],
      [{ choices: [{ finish_reason: 'content_filter' }] }, '服务方过滤'],
    ] as const) {
      const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(value)));
      await expect(analyzeMessage(message, state.settings, 'key', request)).rejects.toThrow(
        expected,
      );
      expect(request).toHaveBeenCalledTimes(1);
    }
    expect(() =>
      parseSuggestions(
        JSON.stringify({ suggestions: [suggestion, { ...suggestion, actions: ['正常', 123] }] }),
      ),
    ).toThrow('第 2 项字段格式错误：actions.1');
    expect(() => parseSuggestions(JSON.stringify({ suggestions: [] }))).toThrow('1–10');
    expect(() => parseSuggestions(JSON.stringify({ ...suggestion, kind: 'secret text' }))).toThrow(
      'kind',
    );
  });
  it('Markdown 保留用户正文，拒绝损坏文件及伪造边界', () => {
    const first = writeInboxText('', state) + '\n用户自己写的说明\n';
    const next = structuredClone(state);
    next.settings.names = ['<!-- /chaos:qq-inbox -->'];
    const text = writeInboxText(first, next);
    expect(text).toContain('用户自己写的说明');
    expect(readInboxText(text)).toEqual(next);
    expect(() => writeInboxText('已有无管理标记的内容', state)).toThrow('停止覆盖');
  });
});

const reply = (items: unknown[]) =>
  new Response(
    JSON.stringify({
      choices: [
        { finish_reason: 'stop', message: { content: JSON.stringify({ suggestions: items }) } },
      ],
    }),
  );
const catalog = [
  { id: randomUUID(), title: '学业', lines: [{ id: randomUUID(), title: '课程' }] },
  { id: randomUUID(), title: '科研', lines: [] },
];
describe('按消息内容推荐归属', () => {
  it('合法推荐保留；编造或已结束的归属按消息内容自动新建', async () => {
    const existing = {
      kind: 'existing' as const,
      lineId: catalog[0].lines[0].id,
      reason: '课程通知',
    };
    const request = vi.fn().mockResolvedValue(reply([{ ...suggestion, destination: existing }]));
    const result = await analyzeMessage(message, state.settings, 'key', request, { catalog });
    expect(result[0].destination).toEqual(existing);
    const payload = JSON.parse(request.mock.calls[0][1].body);
    expect(payload.messages[1].content).toBeTruthy();
    const sent = JSON.parse(payload.messages[1].content);
    expect(sent.workspace).toEqual(catalog);
    expect(sent.defaultLineTitle).toBeNull();
    expect(sent.routingInstructions).toContain('destination');

    request.mockResolvedValue(
      reply([{ ...suggestion, destination: { ...existing, lineId: randomUUID() } }]),
    );
    const stale = await analyzeMessage(message, state.settings, 'key', request, { catalog });
    expect(stale[0].destination).toMatchObject({
      kind: 'newProject',
      projectTitle: '提交材料',
      lineTitle: '提交材料',
    });
    expect(stale[0].uncertainty).toContain('自动新建');

    request.mockResolvedValue(reply([{ ...suggestion, destination: null }]));
    const missing = await analyzeMessage(message, state.settings, 'key', request, { catalog });
    expect(missing[0].destination).toMatchObject({ kind: 'newProject', lineTitle: '提交材料' });
    expect(missing[0].uncertainty).toContain('未给出明确归属');

    request.mockResolvedValue(
      reply([
        {
          ...suggestion,
          kind: 'change',
          destination: { kind: 'newProject', projectTitle: '科研', lineTitle: '论文', reason: '' },
        },
      ]),
    );
    const change = await analyzeMessage(message, state.settings, 'key', request, { catalog });
    expect(change[0].destination).toBeNull();
  });

  it('模型返回与现有事项同名的任务时转为变更，并传入北京时间', async () => {
    const existingItems = [
      {
        id: randomUUID(),
        type: 'milestone' as const,
        title: '提交材料',
        dueDate: '2026-10-29',
        dueTime: '05:00',
        lineTitle: '课程',
      },
    ];
    const request = vi.fn().mockResolvedValue(reply([{ ...suggestion, destination: null }]));
    const result = await analyzeMessage(message, state.settings, 'key', request, {
      catalog,
      existing: existingItems,
    });
    expect(result[0].kind).toBe('change');
    expect(result[0].destination).toBeNull();
    expect(result[0].uncertainty).toContain('已有事项');
    const payload = JSON.parse(request.mock.calls[0][1].body);
    const sent = JSON.parse(payload.messages[1].content);
    expect(sent.message.sentAtLocal).toBe('2026-10-28T08:00:00');
    expect(sent.message.sentAtDate).toBe('2026-10-28');
    expect(sent.existingItems).toEqual(existingItems);
  });

  it('会话默认业务线优先：不推荐、不发送工作空间，模型给出归属也忽略', async () => {
    const settings = structuredClone(state.settings);
    settings.rules[0].lineId = catalog[0].lines[0].id;
    const request = vi.fn().mockResolvedValue(
      reply([
        {
          ...suggestion,
          destination: {
            kind: 'newProject',
            projectTitle: '临时',
            lineTitle: '临时线',
            reason: '不应创建',
          },
        },
      ]),
    );
    const result = await analyzeMessage(message, settings, 'key', request, {
      catalog,
      defaultLine: { title: '课程' },
    });
    expect(result[0].destination).toBeNull();
    const payload = JSON.parse(request.mock.calls[0][1].body);
    const sent = JSON.parse(payload.messages[1].content);
    expect(sent.workspace).toEqual([]);
    expect(sent.defaultLineTitle).toBe('课程');
    expect(sent.routingInstructions).toContain('默认业务线');
  });

  it('归属推荐格式不完整时保留事项并提示，而不是整条失败', () => {
    const items = [
      { ...suggestion, destination: { kind: 'newLine', lineTitle: '没有项目', reason: 'x' } },
      {
        ...suggestion,
        destination: { kind: 'newProject', projectTitle: '科研', lineTitle: '论文' },
      },
      { ...suggestion, destination: '随便一句' },
    ];
    const parsed = parseSuggestions(JSON.stringify({ suggestions: items }));
    expect(parsed[0].destination).toBeNull();
    expect(parsed[0].uncertainty).toContain('归属推荐不完整');
    expect(parsed[1].destination).toMatchObject({
      kind: 'newProject',
      reason: '',
      projectTitle: '科研',
    });
    expect(parsed[2].destination).toBeNull();
    expect(parsed[2].uncertainty).toContain('归属推荐不完整');
  });
});

describe('AI 提供商', () => {
  it('默认 DeepSeek 保持原有地址与请求字段', async () => {
    const request = vi.fn().mockResolvedValue(reply([suggestion]));
    await analyzeMessage(message, state.settings, 'key', request);
    expect(request.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({
      model: 'deepseek-flash',
      thinking: { type: 'disabled' },
      max_tokens: 4000,
      response_format: { type: 'json_object' },
    });
  });

  it('OpenAI 使用自己的地址、模型和 token 字段', async () => {
    const request = vi.fn().mockResolvedValue(reply([suggestion]));
    await analyzeMessage(message, state.settings, 'key', request, {
      ai: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
        jsonMode: true,
      },
    });
    expect(request.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: 'gpt-test',
      response_format: { type: 'json_object' },
    });
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('自定义接口可关闭 JSON 模式，完整端点不重复拼接', async () => {
    expect(chatEndpoint('http://127.0.0.1:11434/v1')).toBe(
      'http://127.0.0.1:11434/v1/chat/completions',
    );
    expect(chatEndpoint('https://x.test/v1/chat/completions/')).toBe(
      'https://x.test/v1/chat/completions',
    );
    const request = vi.fn().mockResolvedValue(reply([suggestion]));
    await analyzeMessage(message, state.settings, 'key', request, {
      ai: {
        provider: 'custom',
        baseUrl: 'https://x.test/v1',
        model: 'custom-model',
        jsonMode: false,
      },
    });
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: 'custom-model' });
    expect(body.response_format).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it('错误信息标注当前提供商且不包含密钥', async () => {
    const request = vi.fn().mockResolvedValue(new Response('provider error', { status: 401 }));
    const error = await analyzeMessage(message, state.settings, 'sk-secret-value', request, {
      ai: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
        jsonMode: true,
      },
    }).catch((value: unknown) => value);
    expect(String(error)).toContain('OpenAI');
    expect(String(error)).not.toContain('sk-secret-value');
    expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-secret-value');
  });
});

describe('自动命名归属', () => {
  const project = {
    id: randomUUID(),
    title: '学业',
    lines: [{ id: randomUUID(), title: '课程' }],
  };
  it('优先复用业务线，其次在相关项目下新建，否则新建项目', () => {
    expect(fallbackDestination('提交课程作业', '学业课程作业', [project])).toMatchObject({
      kind: 'existing',
      lineId: project.lines[0].id,
    });
    expect(fallbackDestination('提交作业', '学业安排', [project])).toMatchObject({
      kind: 'newLine',
      projectId: project.id,
      lineTitle: '提交作业',
    });
    expect(fallbackDestination('寒期项目报名', '示例学院寒期项目', [project])).toMatchObject({
      kind: 'newProject',
      projectTitle: '寒期项目报名',
      lineTitle: '寒期项目报名',
    });
  });
  it('从建议标题安全命名，空标题与换行有兜底', () => {
    expect(fallbackDestination('  ', '', [])).toMatchObject({
      kind: 'newProject',
      projectTitle: '待整理',
      lineTitle: '待整理',
    });
    expect(fallbackDestination('报名\n截止', '', [])).toMatchObject({ lineTitle: '报名 截止' });
    expect(fallbackDestination('寒期报名', '', [project], project.id)).toMatchObject({
      kind: 'newLine',
      projectId: project.id,
    });
  });
});

describe('会话限定项目', () => {
  const project = {
    id: randomUUID(),
    title: '寒期项目',
    lines: [{ id: randomUUID(), title: '申报' }],
  };
  const scopedCatalog = [project];
  const projectScope = { id: project.id, title: project.title };
  it('模型新建项目时改为在限定项目下新建业务线', async () => {
    const request = vi.fn().mockResolvedValue(
      reply([
        {
          ...suggestion,
          destination: {
            kind: 'newProject',
            projectTitle: '另一个项目',
            lineTitle: '报名',
            reason: '内容不匹配',
          },
        },
      ]),
    );
    const result = await analyzeMessage(message, state.settings, 'key', request, {
      catalog: scopedCatalog,
      projectScope,
    });
    expect(result[0].destination).toMatchObject({
      kind: 'newLine',
      projectId: project.id,
      lineTitle: '报名',
    });
    const sent = JSON.parse(JSON.parse(request.mock.calls[0][1].body).messages[1].content);
    expect(sent.projectScopeTitle).toBe('寒期项目');
    expect(sent.routingInstructions).toContain('限定');
  });
  it('越界或缺失归属时也在限定项目下自动新建业务线', async () => {
    const request = vi.fn().mockResolvedValue(
      reply([
        {
          ...suggestion,
          destination: { kind: 'existing', lineId: randomUUID(), reason: '越界' },
        },
      ]),
    );
    const outside = await analyzeMessage(message, state.settings, 'key', request, {
      catalog: scopedCatalog,
      projectScope,
    });
    expect(outside[0].destination).toMatchObject({ kind: 'newLine', projectId: project.id });
    request.mockResolvedValue(reply([{ ...suggestion, destination: null }]));
    const missing = await analyzeMessage(message, state.settings, 'key', request, {
      catalog: scopedCatalog,
      projectScope,
    });
    expect(missing[0].destination).toMatchObject({ kind: 'newLine', projectId: project.id });
  });
});
