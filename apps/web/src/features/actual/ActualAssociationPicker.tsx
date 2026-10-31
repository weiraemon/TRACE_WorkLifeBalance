import { useState } from 'react';
import type { Snapshot } from '../../../../../packages/domain/index';
import { AssociationCandidates } from './AssociationCandidates';
import { SelectedAssociations } from './SelectedAssociations';
import type { ActualAssociations } from './useActualAssociations';

export function ActualAssociationPicker({
  snapshot,
  selection,
}: {
  snapshot: Snapshot;
  selection: ActualAssociations;
}) {
  const [lineId, setLineId] = useState('');
  return (
    <>
      <details className="association-disclosure">
        <summary>关联节点或待办（可选）</summary>
        <AssociationCandidates
          snapshot={snapshot}
          selection={selection}
          lineId={lineId}
          setLineId={setLineId}
        />
      </details>
      <SelectedAssociations selection={selection} />
    </>
  );
}
