import { useState } from 'react';
import type { Snapshot } from '../../../../../packages/domain/index';
import { AssociationCandidates } from './AssociationCandidates';
import { SelectedAssociations } from './SelectedAssociations';
import type { ActualAssociations } from './useActualAssociations';

export function ActualAssociationPicker({
  snapshot,
  selection,
  date,
}: {
  snapshot: Snapshot;
  selection: ActualAssociations;
  date: string;
}) {
  const [lineId, setLineId] = useState('');
  return (
    <>
      <section className="association-disclosure" aria-label="关联节点或待办">
        <h3>关联</h3>
        <AssociationCandidates
          snapshot={snapshot}
          selection={selection}
          date={date}
          lineId={lineId}
          setLineId={setLineId}
        />
      </section>
      <SelectedAssociations selection={selection} />
    </>
  );
}
