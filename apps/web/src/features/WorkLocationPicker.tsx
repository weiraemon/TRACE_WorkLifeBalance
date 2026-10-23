import type { Entry, SpaceItem } from '../../../../packages/domain/index';
import { Field } from '../components/ui';
export type WorkLocation = { projectId: string; lineId: string; milestoneId: string };
export function initialLocation(
  entries: Entry[],
  item?: SpaceItem,
  defaults: Record<string, unknown> = {},
): WorkLocation {
  const records = entries.map((e) => e.data);
  let milestoneId = item?.type === 'todo' ? item.milestoneId : String(defaults.milestoneId ?? '');
  if (!milestoneId && records.filter((r) => r.type === 'milestone').length === 1)
    milestoneId = records.find((r) => r.type === 'milestone')!.id;
  const milestone = records.find((r) => r.id === milestoneId);
  let lineId =
    item?.type === 'milestone'
      ? item.lineId
      : String(defaults.lineId ?? (milestone?.type === 'milestone' ? milestone.lineId : ''));
  if (!lineId && records.filter((r) => r.type === 'workline').length === 1)
    lineId = records.find((r) => r.type === 'workline')!.id;
  const line = records.find((r) => r.id === lineId);
  let projectId =
    item?.type === 'workline'
      ? item.projectId
      : String(defaults.projectId ?? (line?.type === 'workline' ? line.projectId : ''));
  if (!projectId && records.filter((r) => r.type === 'project').length === 1)
    projectId = records.find((r) => r.type === 'project')!.id;
  return { projectId, lineId, milestoneId };
}
export function WorkLocationPicker({
  entries,
  level,
  value,
  onChange,
}: {
  entries: Entry[];
  level: 'workline' | 'milestone' | 'todo';
  value: WorkLocation;
  onChange: (value: WorkLocation) => void;
}) {
  const records = entries.map((e) => e.data);
  const projects = records.filter((r) => r.type === 'project');
  const lines = records.filter((r) => r.type === 'workline' && r.projectId === value.projectId);
  const milestones = records.filter((r) => r.type === 'milestone' && r.lineId === value.lineId);
  const options = (items: typeof records) => (
    <>
      <option value="">请选择</option>
      {items.map((r) => (
        <option key={r.id} value={r.id}>
          {'title' in r ? r.title : r.id}
        </option>
      ))}
    </>
  );
  return (
    <div className="location-picker">
      <Field label="所属项目">
        <select
          required
          value={value.projectId}
          onChange={(e) => {
            const available = records.filter(
              (r) => r.type === 'workline' && r.projectId === e.target.value,
            );
            const lineId = available.length === 1 ? available[0].id : '';
            const points = records.filter((r) => r.type === 'milestone' && r.lineId === lineId);
            onChange({
              projectId: e.target.value,
              lineId,
              milestoneId: points.length === 1 ? points[0].id : '',
            });
          }}
        >
          {options(projects)}
        </select>
      </Field>
      {level !== 'workline' && (
        <Field label="所属业务线">
          <select
            required
            value={value.lineId}
            onChange={(e) => {
              const available = records.filter(
                (r) => r.type === 'milestone' && r.lineId === e.target.value,
              );
              onChange({
                ...value,
                lineId: e.target.value,
                milestoneId: available.length === 1 ? available[0].id : '',
              });
            }}
          >
            {options(lines)}
          </select>
        </Field>
      )}
      {level === 'todo' && (
        <Field label="所属关键节点">
          <select
            required
            value={value.milestoneId}
            onChange={(e) => onChange({ ...value, milestoneId: e.target.value })}
          >
            {options(milestones)}
          </select>
        </Field>
      )}
    </div>
  );
}
