import { z } from 'zod';

export const changesSchema = z
  .array(
    z
      .object({
        path: z.string().min(1),
        expected: z.string().nullable(),
        content: z.string().nullable(),
      })
      .strict(),
  )
  .max(10000);
export type FileChange = z.infer<typeof changesSchema>[number];
