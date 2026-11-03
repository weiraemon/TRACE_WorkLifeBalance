import fs from 'node:fs/promises';
import { z } from 'zod';
import { exchangeBundleSchema, exchangeReceiptSchema } from '../packages/domain/exchange';

await fs.writeFile(
  'docs/architecture/chaos-exchange-v1.schema.json',
  JSON.stringify(
    {
      ...z.toJSONSchema(z.union([exchangeBundleSchema, exchangeReceiptSchema])),
      title: 'CHAOS Exchange v1',
      description:
        'JSON UTF-8 exchange bundle or receipt. Semantic hashes and cross-object checks are additionally enforced by WorkspaceService.',
    },
    null,
    2,
  ) + '\n',
);
