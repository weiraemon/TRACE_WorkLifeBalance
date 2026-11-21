import { CalendarIcon, ClockIcon } from '@radix-ui/react-icons';
import type { InputHTMLAttributes } from 'react';

export function DateTimeInput({
  value,
  type = 'date',
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className="date-time-input">
      <span aria-hidden="true">{value || '未定'}</span>
      {type === 'time' ? <ClockIcon aria-hidden="true" /> : <CalendarIcon aria-hidden="true" />}
      <input {...props} type={type} value={value} />
    </span>
  );
}
