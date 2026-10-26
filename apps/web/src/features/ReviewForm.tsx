import { useState } from 'react';
import { save, createRecord } from '../api';
import { Modal, Field, Button, ErrorMessage, DatePicker } from '../components/ui';
import type { Editor } from './editor';
export function ReviewForm({
  editor,
  close,
  reload,
}: {
  editor: Editor;
  close: () => void;
  reload: () => Promise<void>;
}) {
  const old = editor.entry?.data.type === 'review' ? editor.entry.data : undefined;
  const [value, setValue] = useState(() => ({
    week: old?.week ?? String(editor.defaults?.week ?? ''),
    mainline: old?.mainline ?? '',
    outcomes: old?.outcomes ?? '',
    reflection: old?.reflection ?? '',
    nextWeek: old?.nextWeek ?? '',
  }));
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const field = (key: 'mainline' | 'outcomes' | 'reflection' | 'nextWeek', label: string) => (
    <Field label={label}>
      <textarea
        rows={3}
        value={value[key]}
        onChange={(e) => setValue((s) => ({ ...s, [key]: e.target.value }))}
      />
    </Field>
  );
  return (
    <Modal title="每周回顾" onClose={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            await save(createRecord('review', { ...old, ...value }), editor.entry);
            await reload();
            close();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="本周">
          <DatePicker
            value={value.week}
            onChange={(e) => setValue((s) => ({ ...s, week: e.target.value }))}
          />
        </Field>
        {field('outcomes', '本周进展')}
        <details className="optional-settings">
          <summary>再多写一点（可选）</summary>
          {field('mainline', '本周主线')}
          {field('reflection', '体会与问题')}
          {field('nextWeek', '下周继续什么')}
        </details>
        <ErrorMessage message={error} />
        <div className="form-actions">
          <Button type="button" onClick={close}>
            取消
          </Button>
          <Button className="primary" type="submit" disabled={busy}>
            {busy ? '正在保存…' : '保存到 Vault'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
