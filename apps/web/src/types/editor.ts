import type { Entry, SpaceItem } from '../../../../packages/domain/index';
export type Editor = {
  type: SpaceItem['type'] | 'actual' | 'review';
  entry?: Entry;
  defaults?: Record<string, unknown>;
};
