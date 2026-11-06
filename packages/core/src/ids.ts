import { z } from 'zod';

/**
 * Ids of datasets and widgets. A module of its own because pipeline steps name datasets too, and `schema.ts` (which
 * imports the steps) cannot be imported back by `transforms.ts`.
 */
export const IdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,39}$/,
    'Ids are 1-40 chars of a-z, 0-9, "_" or "-", starting with a letter or digit',
  );
