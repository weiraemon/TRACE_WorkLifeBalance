import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vault } from '../apps/local-service/src/vault';
import { localDay, parseRecord, type RecordData } from '../packages/domain/index';
const root = path.resolve(process.argv[2] ?? 'examples/workspace-vault');
await fs.mkdir(root, { recursive: true });
if ((await fs.readdir(root)).some((name) => name !== '.gitkeep'))
  throw new Error('仅向空目录生成示例，拒绝覆盖任何现有资料');
await fs.mkdir(path.join(root, '资料/阶段报告'), { recursive: true });
await fs.writeFile(
  path.join(root, '欢迎.md'),
  '# ATLAS 四层工作空间示例\n\n项目 → 业务线 → 关键节点 → 待办。\n工作空间安排计划，今日记录实际与快速收集 TODO／IDEA。\n这些是可在 Markdown 编辑器中直接读取的真实文件。\n',
);
await fs.writeFile(
  path.join(root, '资料/阶段报告/说明.md'),
  '# 报告目录\n\n把你自己的 Word、PDF 和仿真输出放在这里，ATLAS 只做关联。\n',
);
const vault = await Vault.open(root);
const today = localDay();
const next = new Date(today + 'T12:00:00');
next.setDate(next.getDate() + 1);
const tomorrow = localDay(next);
const write = async (type: RecordData['type'], fields: object, comment = '') => {
  const now = new Date().toISOString(),
    id = randomUUID();
  return vault.save(
    parseRecord({
      schemaVersion: 1,
      id,
      type,
      createdAt: now,
      updatedAt: now,
      ...fields,
    }),
    undefined,
    comment ? { comments: [{ id: randomUUID(), targetId: id, text: comment }] } : undefined,
  );
};
try {
  const project = await write('project', { title: '项目 A · 抓捕策略研究', importance: 5 });
  const folder = await write('resource', {
    title: '阶段报告资料',
    target: '资料/阶段报告',
    location: 'vault',
  });
  const report = await write('workline', {
    title: '阶段报告',
    projectId: project.data.id,
    importance: 5,
    resourceIds: [folder.data.id],
  });
  const discussion = await write('milestone', {
    title: '指标讨论',
    dueTime: '10:00',
    lineId: report.data.id,

    dueDate: today,
    importance: 4,
  });
  await write('todo', {
    title: '比较两组指标差异',
    milestoneId: discussion.data.id,
    importance: 5,
  });
  await write('todo', {
    title: '把修改意见发给小王',
    milestoneId: discussion.data.id,
    direction: 'to',
    person: '小王',
    importance: 4,
  });
  await write('todo', {
    title: '收到实验图和原始数据',
    milestoneId: discussion.data.id,
    direction: 'from',
    person: '小王',
    importance: 5,
  });
  const review = await write('milestone', {
    title: 'V2 审阅',
    dueTime: '10:00',
    lineId: report.data.id,

    dueDate: tomorrow,
    importance: 5,
    order: 1,
  });
  await write('todo', {
    title: '核对报告图表编号',
    milestoneId: review.data.id,
    importance: 3,
  });
  const revise = await write('milestone', {
    title: '补充修改',
    lineId: report.data.id,
    order: 2,
  });
  await write('todo', {
    title: '补充误差分析',
    milestoneId: revise.data.id,
    importance: 4,
  });
  const code = await write('workline', {
    title: '仿真与验证',
    projectId: project.data.id,
    importance: 4,
    order: 1,
  });
  const test = await write('milestone', {
    title: '边界工况检查',
    dueTime: '12:00',
    lineId: code.data.id,

    dueDate: today,
    importance: 4,
  });
  const checked = await write('todo', {
    title: '核对参数单位',
    milestoneId: test.data.id,
    importance: 3,
    completedAt: new Date().toISOString(),
  });
  await write('todo', {
    title: '补跑边界工况',
    milestoneId: test.data.id,
    importance: 5,
  });
  await write('actual', {
    date: today,
    startTime: '09:03',
    endTime: '09:37',
    itemIds: [checked.data.id],
    description: '核对参数单位，未发现错误',
  });
  const other = await write('project', { title: '科研 · 长期积累' });
  const paper = await write('workline', {
    title: '相对运动方法论文',
    projectId: other.data.id,
  });
  await write(
    'milestone',
    { title: '选题交流', lineId: paper.data.id, tags: ['会议'] },
    '先比较两种方法，再选择需要验证的问题。',
  );
  const pool = (await vault.scan()).entries.find(
    (e) => e.data.type === 'milestone' && e.data.pool && e.data.lineId === paper.data.id,
  )!;
  await write(
    'todo',
    { title: '异常是否来自样本分布？', kind: 'idea', milestoneId: pool.data.id },
    '先保留这个问题，下一次实验检查分布差异。',
  );
  console.log('Created real workspace Vault: ' + root);
} finally {
  await vault.close();
}
