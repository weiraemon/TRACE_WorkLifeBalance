import * as Dialog from '@radix-ui/react-dialog';
import { Cross2Icon } from '@radix-ui/react-icons';
import {
  Children,
  cloneElement,
  isValidElement,
  type ButtonHTMLAttributes,
  type ReactNode,
  type ReactElement,
} from 'react';
export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={'button ' + className} {...props} />;
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
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
          className={'dialog ' + (wide ? 'wide' : '')}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <div className="section-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button aria-label="关闭对话框" className="icon">
                <Cross2Icon />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            保存到当前 Obsidian Vault。未保存的内容在关闭后放弃。
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
        (['input', 'select', 'textarea'].includes(String(child.type)) || child.type === DatePicker)
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
