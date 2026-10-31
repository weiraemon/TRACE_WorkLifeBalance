import { randomUUID } from 'node:crypto';
import {
  isSpaceItem,
  parseRecord,
  localDay,
  validateChange,
  type BusinessLine,
  type Milestone,
  type Todo,
  type RecordData,
  type SaveOptions,
} from '../../../../packages/domain/index';
import {
  businessCommandSchema,
  planSchema,
  resolvePlanDestination,
  type PlanDestination,
} from '../../../../packages/domain/business';
import { Vault, VaultError, type FileChange } from '../native/vault';
import { appendComment } from '../native/line-notes';

export class WorkspaceService {
  constructor(readonly vault: Vault) {}
  snapshot() {
    return this.vault.scan();
  }
  saveRecord(
    data: unknown,
    revision?: string,
    options: SaveOptions = {},
    companions: FileChange[] = [],
  ) {
    return this.vault.save(data, revision, options, companions);
  }
  private async target(id: string, revision: string) {
    const snapshot = await this.snapshot();
    const matches = snapshot.entries.filter((entry) => entry.data.id === id);
    if (matches.length !== 1 || matches[0].revision !== revision)
      throw new VaultError('对象已更改或不存在，请重新加载', 409);
    return matches[0];
  }
  async complete(id: string, revision: string, completed: boolean, companions: FileChange[] = []) {
    const entry = await this.target(id, revision);
    if (!isSpaceItem(entry.data)) throw new VaultError('此对象不支持完成');
    return this.saveRecord(entry.data, entry.revision, { completion: completed }, companions);
  }
  async reschedule(
    id: string,
    revision: string,
    dueDate: string | null,
    dueTime?: string | null,
    location?: string | null,
    companions: FileChange[] = [],
  ) {
    const entry = await this.target(id, revision);
    const data = entry.data;
    if (data.type !== 'milestone' && data.type !== 'todo')
      throw new VaultError('只有节点或条目可以改期');
    if (data.type === 'todo' && dueTime)
      throw new VaultError('待办没有独立时刻，请修改所属节点或先升为节点');
    return this.saveRecord(
      {
        ...data,
        dueDate,
        ...(data.type === 'milestone'
          ? {
              dueTime: dueDate ? (dueTime === undefined ? data.dueTime : dueTime) : null,
              location: location === undefined ? data.location : location,
            }
          : {}),
      },
      entry.revision,
      {},
      companions,
    );
  }
  async createPlan(input: unknown, companions: FileChange[] = []) {
    const plan = planSchema.parse(input);
    let lineId = plan.lineId;
    return this.vault.applyBatch(async (tx) => {
      const snapshot = tx.snapshot;
      const now = new Date().toISOString();
      const make = (type: string, fields: object) =>
        parseRecord({
          schemaVersion: 1,
          id: randomUUID(),
          createdAt: now,
          updatedAt: now,
          type,
          ...fields,
        });
      const records: RecordData[] = [];
      const bodies = new Map<string, string>();
      const catalog = snapshot.entries.flatMap(({ data: p }) =>
        p.type === 'project' && !p.completedAt
          ? [
              {
                id: p.id,
                title: p.title,
                lines: snapshot.entries.flatMap(({ data: l }) =>
                  l.type === 'workline' && l.projectId === p.id && !l.completedAt
                    ? [{ id: l.id, title: l.title }]
                    : [],
                ),
              },
            ]
          : [],
      );
      let target: PlanDestination | null = plan.destination ?? null;
      const scopedId = plan.projectId;
      const scopedProject = scopedId ? catalog.find((p) => p.id === scopedId) : undefined;
      if (scopedId && !scopedProject)
        throw new VaultError('会话限定项目已删除或结束，无法创建业务线');
      const scopeCatalog = scopedProject ? [scopedProject] : catalog;
      if (scopedProject && target?.kind === 'newProject')
        target = {
          kind: 'newLine',
          projectId: scopedProject.id,
          lineTitle: target.lineTitle,
          reason: target.reason,
        };
      const lineAvailable = (id: string) => {
        const entry = snapshot.entries.find((e) => e.data.id === id && e.data.type === 'workline');
        if (!entry) return false;
        const data = entry.data;
        if (data.type !== 'workline' || data.completedAt) return false;
        const parent = snapshot.entries.find((e) => e.data.id === data.projectId);
        return Boolean(parent && parent.data.type === 'project' && !parent.data.completedAt);
      };
      if (lineId && !lineAvailable(lineId)) lineId = '';
      if (
        lineId &&
        scopedProject &&
        !scopeCatalog.some((p) => p.lines.some((l) => l.id === lineId))
      )
        lineId = '';
      if (!lineId) {
        const current = target;
        const stale =
          current == null ||
          (current.kind === 'existing' &&
            !scopeCatalog.some((p) => p.lines.some((l) => l.id === current.lineId))) ||
          (current.kind === 'newLine' && !scopeCatalog.some((p) => p.id === current.projectId));
        if (stale)
          target = resolvePlanDestination(
            plan.title,
            plan.context,
            scopeCatalog,
            scopedProject?.id ?? null,
          );
      }
      if (!lineId && target?.kind === 'existing') lineId = target.lineId;
      if (!lineId && target && target.kind !== 'existing') {
        const normalize = (s: string) => s.normalize('NFKC').trim().toLowerCase();
        const cleanTitle = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
        const projectTitle = target.kind === 'newProject' ? cleanTitle(target.projectTitle) : '';
        const lineTitle = cleanTitle(target.lineTitle);
        if (!lineTitle) throw new VaultError('推荐业务线名称无效，请手动填写');
        if (target.kind === 'newProject' && !projectTitle)
          throw new VaultError('推荐项目名称无效，请手动填写');
        let projectId = target.kind === 'newLine' ? target.projectId : '';
        if (target.kind === 'newProject') {
          const matches = snapshot.entries.filter(
            (e) =>
              e.data.type === 'project' &&
              !e.data.completedAt &&
              normalize(e.data.title) === normalize(projectTitle),
          );
          if (matches.length > 1) throw new VaultError('同名项目不唯一，请手动选择业务线');
          if (matches.length) projectId = matches[0].data.id;
          else {
            const project = make('project', { title: projectTitle });
            records.push(project);
            projectId = project.id;
          }
        }
        const parent = [...snapshot.entries.map((e) => e.data), ...records].find(
          (r) => r.id === projectId,
        );
        if (parent?.type !== 'project' || parent.completedAt)
          throw new VaultError('推荐项目已删除或结束，请重新选择归属');
        const matches = snapshot.entries.filter(
          (e) =>
            e.data.type === 'workline' &&
            !e.data.completedAt &&
            e.data.projectId === projectId &&
            normalize(e.data.title) === normalize(lineTitle),
        );
        if (matches.length > 1) throw new VaultError('同名业务线不唯一，请手动选择');
        if (matches.length) lineId = matches[0].data.id;
        else {
          const parts = tx.createLineParts(
            make('workline', { title: lineTitle, projectId }) as BusinessLine,
          );
          records.push(...parts);
          const newLine = parts[0] as BusinessLine;
          lineId = newLine.id;
          bodies.set(newLine.notesId!, '\n# ' + newLine.title + '\n');
        }
      }
      const working = [
        ...snapshot.entries,
        ...records.map((data) => ({ data, path: '', revision: '' })),
      ];
      const lines = working.filter((e) => e.data.id === lineId);
      const line = lines.length === 1 ? lines[0].data : undefined;
      const project =
        line?.type === 'workline'
          ? working.find((e) => e.data.id === line.projectId)?.data
          : undefined;
      if (
        line?.type !== 'workline' ||
        line.completedAt ||
        project?.type !== 'project' ||
        project.completedAt
      )
        throw new VaultError('请选择未结束项目中的业务线');
      const pools = working.filter(
        (e) => e.data.type === 'milestone' && e.data.lineId === lineId && e.data.pool,
      );
      if (pools.length !== 1) throw new VaultError('业务线待办池缺失或重复');
      let node = pools[0].data as Milestone;
      if (plan.kind === 'event' || plan.dueDate) {
        node = make('milestone', {
          title: plan.title,
          lineId,
          dueDate: plan.dueDate,
          dueTime: plan.dueTime,
          tags: plan.tags,
          location: plan.location,
        }) as Milestone;
        records.push(node);
      }
      const titles = plan.actions.length ? plan.actions : plan.kind === 'task' ? [plan.title] : [];
      for (const title of titles)
        records.push(
          make('todo', {
            title,
            milestoneId: node.id,
            dueDate: node.pool ? plan.dueDate : null,
          }),
        );
      const virtual = [
        ...snapshot.entries,
        ...records.map((data) => ({ data, path: '', revision: '' })),
      ];
      for (const record of records) validateChange(record, virtual);

      if (plan.note) {
        const original = await tx.notesBody(line, bodies);
        bodies.set(
          line.notesId!,
          appendComment(
            original,
            node,
            node.pool ? (records.find((record) => record.type === 'todo') as Todo) : undefined,
            plan.note,
          ),
        );
      }
      return {
        records,
        bodies,
        files: companions,
        result: { ids: records.map((record) => record.id) },
      };
    });
  }
  async execute(input: unknown) {
    const command = businessCommandSchema.parse(input);
    switch (command.type) {
      case 'record.save':
        return this.saveRecord(command.data, command.revision, command.options);
      case 'work.complete':
        return this.complete(command.id, command.revision, command.completed);
      case 'work.reschedule':
        return this.reschedule(
          command.id,
          command.revision,
          command.dueDate,
          command.dueTime,
          command.location,
        );
      case 'work.comment': {
        const entry = await this.target(command.id, command.revision);
        return this.saveRecord(entry.data, entry.revision, {
          comments: [
            {
              id: randomUUID(),
              targetId: command.id,
              text: command.text,
              date: command.date ?? localDay(),
            },
          ],
        });
      }
      case 'plan.create':
        return this.createPlan(command.plan);
      case 'work.promote':
        return this.vault.promote(command.id, command.revision);
      case 'work.deletePreview':
        return this.vault.deletePreview(command.id);
      case 'work.delete':
        return this.vault.deleteSpace(command.id, command.expectations);
      case 'notes.read':
        return this.vault.readContent(command.id);
      case 'notes.save':
        return this.vault.saveContent(command.id, command.body, command.revision);
    }
  }
}
const services = new WeakMap<Vault, WorkspaceService>();
export function workspaceServiceFor(vault: Vault) {
  let service = services.get(vault);
  if (!service) {
    service = new WorkspaceService(vault);
    services.set(vault, service);
  }
  return service;
}
