import type { Entry, RecordData } from '../../../../packages/domain/index';
export type Editor = {
  type: RecordData['type'];
  entry?: Entry;
  defaults?: Record<string, unknown>;
};
