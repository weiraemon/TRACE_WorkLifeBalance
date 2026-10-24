import { useEffect, useState } from 'react';
import {
  isSpaceItem,
  type DeletePreview,
  type DeleteResult,
  type Entry,
} from '../../../../packages/domain/index';
import { deletePreview, deleteSpace } from '../api';
import { Button, ErrorMessage, Modal } from '../components/ui';
import { spaceLabel } from './WorkItemForm';

export function DeleteSpaceDialog({
  entry,
  draftAffected,
  close,
  deleted,
}: {
  entry: Entry;
  draftAffected: boolean;
  close: () => void;
  deleted: (result: DeleteResult) => Promise<void>;
}) {
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let ignore = false;
    setPreview(null);
    setError('');
    void deletePreview(entry.data.id)
      .then((value) => {
        if (!ignore) setPreview(value);
      })
      .catch((e) => {
        if (!ignore) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      ignore = true;
    };
  }, [entry.data.id, retry]);
  const root = preview?.entries.find((e) => e.data.id === entry.data.id)?.data ?? entry.data;
  return (
    <Modal
      title="删除工作内容"
      onClose={() => {
        if (!busy) close();
      }}
    >
      {isSpaceItem(root) && (
        <h3>
          {spaceLabel[root.type]} · {root.title}
        </h3>
      )}
      {!preview && !error && <p role="status">正在检查删除范围…</p>}
      {preview && (
        <>
          <p className="hint">
            将删除以下 {preview.entries.length}{' '}
            项内容，包含下级。绑定的笔记和资源保留；仅保留最近一次删除的撤销记录。
          </p>
          <ul className="delete-scope" aria-label="删除范围">
            {preview.entries.map(
              ({ data }) =>
                isSpaceItem(data) && (
                  <li key={data.id}>
                    {spaceLabel[data.type]} · {data.title}
                  </li>
                ),
            )}
          </ul>
          <ErrorMessage message={preview.blockedReason ?? ''} />
        </>
      )}
      {draftAffected && <p className="error">当前正文草稿尚未保存，确认删除后将放弃该草稿。</p>}
      <ErrorMessage message={error} />
      <div className="actions">
        <Button
          className="danger"
          disabled={!preview || Boolean(preview.blockedReason) || Boolean(error) || busy}
          onClick={async () => {
            if (!preview) return;
            setBusy(true);
            setError('');
            try {
              await deleted(await deleteSpace(entry.data.id, preview.entries));
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          确认删除
        </Button>
        <Button disabled={busy} onClick={close}>
          取消
        </Button>
        {(error || preview?.blockedReason) && (
          <Button disabled={busy} onClick={() => setRetry((value) => value + 1)}>
            重新检查
          </Button>
        )}
      </div>
    </Modal>
  );
}
