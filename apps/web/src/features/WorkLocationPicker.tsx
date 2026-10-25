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
  const point = records.find((r) => r.id === milestoneId);
  let lineId =
    item?.type === 'milestone'
      ? item.lineId
      : String(defaults.lineId ?? (point?.type === 'milestone' ? point.lineId : ''));
  if (!lineId && records.filter((r) => r.type === 'workline' && !r.completedAt).length === 1)
    lineId = records.find((r) => r.type === 'workline' && !r.completedAt)!.id;
  const line = records.find((r) => r.id === lineId);
  let projectId =
    item?.type === 'workline'
      ? item.projectId
      : String(defaults.projectId ?? (line?.type === 'workline' ? line.projectId : ''));
  if (!projectId && records.filter((r) => r.type === 'project' && !r.completedAt).length === 1)
    projectId = records.find((r) => r.type === 'project' && !r.completedAt)!.id;
  if (line?.type === 'workline' && line.projectId !== projectId) lineId = '';
  if (!milestoneId)
    milestoneId =
      records.find((r) => r.type === 'milestone' && r.lineId === lineId && r.pool)?.id ?? '';
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
  const poolId = (lineId: string) =>
    records.find((r) => r.type === 'milestone' && r.lineId === lineId && r.pool)?.id ?? '';
  return (
    <div className="location-picker">
      <Field label="所属项目">
        <select
          required
          value={value.projectId}
          onChange={(e) => {
            const lines = records.filter(
              (r) => r.type === 'workline' && r.projectId === e.target.value && !r.completedAt,
            );
            const lineId = lines.length === 1 ? lines[0].id : '';
            onChange({ projectId: e.target.value, lineId, milestoneId: poolId(lineId) });
          }}
        >
          {options(
            records.filter(
              (r) => r.type === 'project' && (!r.completedAt || r.id === value.projectId),
            ),
          )}
        </select>
      </Field>
      {level !== 'workline' && (
        <Field label="所属业务线">
          <select
            required
            value={value.lineId}
            onChange={(e) =>
              onChange({ ...value, lineId: e.target.value, milestoneId: poolId(e.target.value) })
            }
          >
            {options(
              records.filter(
                (r) =>
                  r.type === 'workline' &&
                  r.projectId === value.projectId &&
                  (!r.completedAt || r.id === value.lineId),
              ),
            )}
          </select>
        </Field>
      )}
      {level === 'todo' && (
        <Field label="所属节点">
          <select
            required
            value={value.milestoneId}
            onChange={(e) => onChange({ ...value, milestoneId: e.target.value })}
          >
            {options(records.filter((r) => r.type === 'milestone' && r.lineId === value.lineId))}
          </select>
        </Field>
      )}
    </div>
  );
}
