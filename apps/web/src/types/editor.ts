import type { Entry, SpaceItem } from '../../../../packages/domain/index';
export type AssociationSelection = { has: (id: string) => boolean; toggle: (id: string) => void };
export type Editor = {
  type: SpaceItem['type'] | 'actual' | 'review';
  entry?: Entry;
  defaults?: Record<string, unknown>;
};
