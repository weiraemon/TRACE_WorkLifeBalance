import { useEffect, useState } from 'react';
import type { ActualRecord, Snapshot, Todo, Milestone } from '../../../../../packages/domain/index';
import { isComplete, todoContexts } from '../../../../../packages/domain/workspace';
import type { RecordSource } from './types';

export function useActualAssociations(
  snapshot: Snapshot,
  old?: ActualRecord,
  source?: RecordSource,
) {
  const [milestoneIds, setMilestoneIds] = useState<string[]>(old?.milestoneIds ?? []);
  const [itemIds, setItemIds] = useState<string[]>(old?.itemIds ?? []);
  const [completeIds, setCompleteIds] = useState<string[]>([]);
  const [comments, setComments] = useState<Record<string, { id: string; text: string }>>({});
  const addNode = (id: string) => setMilestoneIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
  const addItem = (id: string) => setItemIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
  useEffect(() => {
    if (!source) return;
    if (source.type === 'milestone') addNode(source.id);
    else addItem(source.id);
  }, [source]);
  const entries = snapshot.entries;
  const contexts = todoContexts(entries);
  const nodes = entries.flatMap(({ data }) =>
    data.type === 'milestone' && !data.pool ? [data] : [],
  );
  const remove = (id: string, type: 'milestone' | 'todo') => {
    (type === 'milestone' ? setMilestoneIds : setItemIds)((ids) =>
      ids.filter((value) => value !== id),
    );
    setCompleteIds((ids) => ids.filter((value) => value !== id));
  };
  const setComment = (id: string, text: string) =>
    setComments((values) => ({
      ...values,
      [id]: { id: values[id]?.id ?? crypto.randomUUID(), text },
    }));
  const inheritedCompletion = (item: Todo) =>
    milestoneIds.includes(item.milestoneId) && completeIds.includes(item.milestoneId);
  return {
    entries,
    contexts,
    nodes,
    milestoneIds,
    itemIds,
    completeIds,
    comments,
    selectedNodes: nodes.filter((node) => milestoneIds.includes(node.id)),
    selectedItems: contexts.filter((context) => itemIds.includes(context.todo.id)),
    addNode,
    addItem,
    remove,
    setComment,
    inheritedCompletion,
    persistedComplete: (item: Todo | Milestone) => isComplete(item, entries),
    markedComplete: (item: Todo | Milestone) =>
      isComplete(item, entries) ||
      completeIds.includes(item.id) ||
      (item.type === 'todo' && inheritedCompletion(item)),
    setComplete: (id: string, checked: boolean) =>
      setCompleteIds((ids) =>
        checked ? [...new Set([...ids, id])] : ids.filter((value) => value !== id),
      ),
    childCount: (id: string) =>
      contexts.filter((context) => context.todo.milestoneId === id).length,
  };
}
export type ActualAssociations = ReturnType<typeof useActualAssociations>;
