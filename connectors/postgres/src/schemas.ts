import { z } from 'zod';
import { DEFAULT_MAX_ROWS, HARD_MAX_ROWS } from './client.js';

/**
 * Upper bound the caller may ask for — the same number `client.ts` cuts at,
 * imported rather than restated so the two cannot drift.
 *
 * The schema rejects an out-of-range request up front, so the caller learns the
 * limit from a validation error instead of from a silently truncated answer.
 */
export const MAX_ROWS_LIMIT = HARD_MAX_ROWS;

const MAX_ROWS_FIELD = z
  .number()
  .int()
  .min(1)
  .max(MAX_ROWS_LIMIT)
  .optional()
  .describe(
    `Maximum rows to return (default ${DEFAULT_MAX_ROWS}, max ${MAX_ROWS_LIMIT}). Rows beyond the limit are dropped and the result says so via has_more, truncated_reason and truncation_note. This is not the only cap: a byte allowance can cut a result well below max_rows.`,
  );

const PARAM_VALUE = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * No connection field on purpose: the credential stays in the connector host, so a
 * model that cannot name the target cannot redirect these tools.
 *
 * `.strict()` because Zod otherwise STRIPS unknown keys — a model reaching for
 * `limit: 500` would silently get 200 rows instead of an `INVALID_INPUT`.
 */
export const executeSqlSchema = z
  .object({
    sql: z
      .string()
      .min(1)
      .describe('SQL to execute. Use $1, $2 … placeholders for values instead of inlining them.'),
    params: z
      .array(PARAM_VALUE)
      .optional()
      .describe(
        'Values for the $1, $2 … placeholders in `sql`. Parameterised values are never parsed as SQL. Note that PostgreSQL allows only one statement per query when parameters are used.',
      ),
    max_rows: MAX_ROWS_FIELD,
  })
  .strict();

export type ExecuteSqlInput = z.infer<typeof executeSqlSchema>;

/** Separate from `executeSqlSchema` because `sql` here promises one statement. */
export const querySchema = z
  .object({
    sql: z
      .string()
      .min(1)
      .describe(
        'A single read-only SQL statement. Use $1, $2 … placeholders for values instead of inlining them. Exactly one statement: a second one is refused by PostgreSQL before any of them runs.',
      ),
    params: z
      .array(PARAM_VALUE)
      .optional()
      .describe(
        'Values for the $1, $2 … placeholders in `sql`. Parameterised values are never parsed as SQL.',
      ),
    max_rows: MAX_ROWS_FIELD,
  })
  .strict();

export type QueryInput = z.infer<typeof querySchema>;
