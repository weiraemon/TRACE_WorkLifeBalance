import { DateTimeInput } from './DateTimeInput';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeftIcon, Cross2Icon } from '@radix-ui/react-icons';
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type ReactElement,
} from 'react';
export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={'button ' + className} {...props} />;
}
export function ActionButton({
  action,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  action: 'save' | 'delete' | 'cancel';
}) {
  const label = action === 'save' ? '保存' : action === 'delete' ? '删除' : '取消';
  const tone = action === 'save' ? 'primary' : action === 'delete' ? 'danger' : '';
  return (
    <Button className={`${tone} ${className}`.trim()} {...props}>
      {children ?? label}
    </Button>
  );
}
export function Select({
  value, options, onChange, disabled = false, mobile = false, 'aria-label': ariaLabel,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  mobile?: boolean;
  'aria-label'?: string;
}) {
  if (!mobile)
    return <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return <div className={`mobile-select${open ? ' is-open' : ''}`} ref={root}>
    <button type="button" className="mobile-select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} disabled={disabled} onClick={() => setOpen((current) => !current)}>
      <span>{selected?.label ?? ''}</span><span className="mobile-select-arrow" aria-hidden="true" />
    </button>
    {open && <div className="mobile-select-menu" role="listbox" aria-label={ariaLabel}>
      {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}</button>)}
    </div>}
  </div>;
}
export function Modal({
  title,
  children,
  onClose,
  onBack,
  wide = false,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onBack?: () => void;
  wide?: boolean;
  className?: string;
}) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = (event: Event) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== content.current) return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('chaos-back', back, true);
    return () => window.removeEventListener('chaos-back', back, true);
  }, [onClose]);
  useEffect(() => {
    const closePicker = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        CSS.supports('selector(select:open)') &&
        document.querySelector('[role="dialog"] select:open')
      )
        event.stopPropagation();
    };
    window.addEventListener('keydown', closePicker, true);
    return () => window.removeEventListener('keydown', closePicker, true);
  }, []);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          ref={content}
          className={`dialog ${wide ? 'wide' : ''} ${className}`}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <div className="section-heading">
            {onBack && (
              <Button aria-label="返回上级菜单" className="icon back-button" onClick={onBack}>
                <ArrowLeftIcon />
              </Button>
            )}
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button aria-label="关闭对话框" className="icon">
                <Cross2Icon />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            在当前 Markdown 工作目录中查看或编辑内容。
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={'field ' + (wide ? 'span-two' : '')}>
      <span>{label}</span>
      {Children.map(children, (child) =>
        isValidElement(child) &&
        (['input', 'select', 'textarea'].includes(String(child.type)) ||
          child.type === DatePicker ||
          child.type === DateTimeInput)
          ? cloneElement(child as ReactElement<{ 'aria-label'?: string }>, { 'aria-label': label })
          : child,
      )}
    </label>
  );
}
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-mark">＋</span>
      <p>{children}</p>
    </div>
  );
}
export function ErrorMessage({ message }: { message: string }) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;
}
export function DatePicker(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="date" {...props} />;
}
