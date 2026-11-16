import { useState } from 'react';
import { activeLines } from '../../../../../packages/domain/workspace';
import type { Entry, Snapshot } from '../../../../../packages/domain/index';
import { save } from '../../api';
import { Button, ErrorMessage, Field, Modal } from '../../components/ui';
import { Workspace } from '../../pages/Workspace';
import { ProjectList } from '../mobile/ProjectList';
import { VerticalLine } from '../mobile/VerticalLine';
import { clearDraft, useDraftState } from '../drafts/useDraftState';
import { useActualAssociations } from './useActualAssociations';
import { SelectedAssociations } from './SelectedAssociations';

export function ActualAssociationMode({
  entry,
  entries,
  snapshot,
  choose,
  close,
  reload,
}: {
  entry: Entry;
  entries: Entry[];
  snapshot: Snapshot;
  choose: (id: string) => void;
  close: () => void;
  reload: () => Promise<void>;
}) {
  const old = entry.data.type === 'actual' ? entry.data : undefined;
  const draftKey = `${snapshot.root}:actual-association:${entry.data.id}`;
  const [revision] = useDraftState(draftKey + ':revision', entry.revision);
  const selection = useActualAssociations(snapshot, old, undefined, draftKey);
  const [lineId, setLineId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mobile = document.documentElement.dataset.surface === 'android';
  const lines = activeLines(snapshot.entries);
  const line = lines.find((line) => line.id === lineId);
  const association = {
    has: (id: string) => selection.milestoneIds.includes(id) || selection.itemIds.includes(id),
    toggle: (id: string) => {
      const record = snapshot.entries.find((entry) => entry.data.id === id)?.data;
      if (record?.type !== 'milestone' && record?.type !== 'todo') return;
      const selected = selection.milestoneIds.includes(id) || selection.itemIds.includes(id);
      if (selected) selection.remove(id, record.type);
      else if (record.type === 'milestone') selection.addNode(id);
      else selection.addItem(id);
    },
  };
  if (!old) return null;
  return (
    <Modal
      title="工作空间 · 关联模式"
      className="association-workspace-dialog"
      onClose={() => !busy && close()}
    >
      <div className="association-mode-bar">
        <Field label="实际记录">
          <select value={old.id} disabled={busy} onChange={(event) => choose(event.target.value)}>
            {entries.map(
              ({ data }) =>
                data.type === 'actual' && (
                  <option key={data.id} value={data.id}>
                    {data.startTime}–{data.endTime} · {data.description}
                  </option>
                ),
            )}
          </select>
        </Field>
        <Button
          disabled={busy}
          onClick={() => {
            clearDraft(draftKey);
            close();
          }}
        >
          取消关联
        </Button>
        <Button
          disabled={busy}
          className="primary"
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await save(
                { ...old, milestoneIds: selection.milestoneIds, itemIds: selection.itemIds },
                { ...entry, revision },
                {
                  completeIds: selection.completeIds.filter(association.has),
                  comments: Object.entries(selection.comments)
                    .filter(([id, comment]) => association.has(id) && comment.text.trim())
                    .map(([targetId, comment]) => ({ ...comment, targetId, date: old.date })),
                },
              );
              await reload();
              clearDraft(draftKey);
              close();
            } catch (error) {
              setError(String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '正在保存…' : '保存关联并返回已做'}
        </Button>
      </div>
      <ErrorMessage message={error} />
      <div className="association-workspace-body" inert={busy}>
        <div className="association-workspace-board">
          {mobile ? (
            line ? (
              <>
                <Button onClick={() => setLineId('')}>返回业务线</Button>
                <VerticalLine
                  snapshot={snapshot}
                  line={line}
                  lines={lines}
                  changeLine={setLineId}
                  select={association.toggle}
                  edit={() => {}}
                  toggle={association.toggle}
                  showOlder={false}
                  association={association}
                />
              </>
            ) : (
              <ProjectList
                snapshot={snapshot}
                query=""
                archived={false}
                select={(line) => setLineId(line.id)}
                edit={() => {}}
              />
            )
          ) : (
            <Workspace
              snapshot={snapshot}
              edit={() => {}}
              select={association.toggle}
              reload={reload}
              run={() => {}}
              query=""
              showArchived={false}
              onShowArchivedChange={() => {}}
              association={association}
            />
          )}
        </div>
        <SelectedAssociations selection={selection} />
      </div>
    </Modal>
  );
}
