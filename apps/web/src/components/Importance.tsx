export const importanceLevels = [
  { value: 1, label: '不急' },
  { value: 2, label: '较缓' },
  { value: 3, label: '一般' },
  { value: 4, label: '较急' },
  { value: 5, label: '很急' },
];
export const importanceLabel = (value: number) =>
  importanceLevels.find((level) => level.value === value)!.label;

export function ImportanceDot({ value }: { value: number }) {
  const label = `重要性：${importanceLabel(value)}`;
  return (
    <span
      className={`importance-dot priority-${value}`}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

export function ImportancePicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="importance-picker" role="group" aria-label="重要性">
      {importanceLevels.map((level) => (
        <button
          key={level.value}
          type="button"
          className={`priority-${level.value}`}
          title={level.label}
          aria-label={`重要性：${level.label}`}
          aria-pressed={value === level.value}
          onClick={() => onChange(level.value)}
        />
      ))}
    </div>
  );
}
