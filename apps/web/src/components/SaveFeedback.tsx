import { useEffect, useState } from 'react';
import { CheckCircledIcon } from '@radix-ui/react-icons';

export function announceSaved() {
  window.dispatchEvent(new Event('chaos-saved'));
}

export function SaveFeedback() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const saved = () => {
      clearTimeout(timer);
      setVisible(true);
      timer = setTimeout(() => setVisible(false), 3000);
    };
    window.addEventListener('chaos-saved', saved);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('chaos-saved', saved);
    };
  }, []);
  return (
    <div className="mobile-save-feedback" role="status" aria-live="polite" aria-atomic="true">
      {visible && (
        <span>
          <CheckCircledIcon />
          已保存
        </span>
      )}
    </div>
  );
}
