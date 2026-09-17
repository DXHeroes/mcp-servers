/**
 * The envelopes a tool call returns, and the truncation they have to announce.
 */
import pg from 'pg';
import { HARD_MAX_ROWS, MAX_RESULT_BYTES } from './limits.js';

export interface ResultField {
  name: string;
  data_type_id: number;
}

/** Which of the two shared allowances ran out. */
export type TruncationReason = 'row_limit' | 'byte_limit';

export interface SqlResultEnvelope {
  /** The command tag PostgreSQL reported (`SELECT`, `UPDATE`, `CREATE`, …). */
  command: string | null;
  /** Rows found (SELECT) or affected (write), as PostgreSQL counted them. */
  row_count: number;
  /** Rows actually present in `rows` — may be fewer than `row_count`. */
  returned: number;
  /**
   * True when rows were dropped; then, and only then, `truncated_reason` and
   * `truncation_note` are set.
   */
  has_more: boolean;
  truncated_reason?: TruncationReason;
  /**
   * What was dropped and what to do about it, in words for the model.
   *
   * Not decoration: the byte budget can cut a result to `returned: 0` while
   * `row_count` says 1 — one wide row, a `bytea` (which serialises as a JSON
   * byte array roughly five times its size) is the easy way there — and
   * `max_rows` cannot help with that at all. Without a note the model is left
   * with an empty `rows` and no route to the data.
   */
  truncation_note?: string;
  fields: ResultField[];
  rows: unknown[];
}

export interface MultiStatementEnvelope {
  statement_count: number;
  /**
   * True when the row/byte allowance shared by the whole call ran out inside
   * this batch. Then, and only then, `truncated_reason`,
   * `truncated_from_statement` and `truncation_note` are present.
   *
   * It is stated here rather than left to be inferred from the last statement:
   * once the budget is gone, every later statement carries an empty `rows`,
   * which is indistinguishable from a query that genuinely matched nothing.
   */
  batch_truncated: boolean;
  truncated_reason?: TruncationReason;
  /** 1-based index of the statement the shared budget ran out on. */
  truncated_from_statement?: number;
  /** What the truncation means and what to do about it, in words for the model. */
  truncation_note?: string;
  statements: SqlResultEnvelope[];
}

/**
 * The row and byte allowance for **one tool call**, spent as the statements of
 * a batch are shaped.
 *
 * Mutable and passed by reference on purpose: it is one budget, and every
 * envelope subtracts what it took. Handing each statement a fresh copy is what
 * let a batch of N statements return N times the documented cap.
 */
export interface ResultBudget {
  rows: number;
  bytes: number;
}

/**
 * One statement's outcome as it is being streamed: the driver's own `Result`
 * (which carries `command`, `rowCount` and `fields` whether or not any rows
 * were kept) and the rows that fitted in the call's budget.
 */
export interface StatementRows {
  result: pg.QueryResult;
  rows: unknown[];
  /** Set the moment a row is dropped, and never unset. */
  reason?: TruncationReason;
}

/** What was dropped and what to do about it, for the model that has to react. */
function truncationNote(reason: TruncationReason, returned: number, rowLimit: number): string {
  const paging =
    'To read the rest, page the query yourself with ORDER BY … LIMIT … OFFSET …, or narrow it with a WHERE clause.';
  if (reason === 'row_limit') {
    return `The row allowance for this tool call (${rowLimit} row(s)) ran out, so rows the database produced are missing from "rows" — "row_count" is what it actually counted. Ask for more with max_rows (up to ${HARD_MAX_ROWS}). ${paging}`;
  }
  if (returned === 0) {
    return `The very first row on its own exceeded the ~${Math.round(MAX_RESULT_BYTES / 1000)} kB byte allowance for this tool call, so "rows" is empty even though the database produced rows — an empty "rows" here does NOT mean the query matched nothing, and max_rows cannot help. Return less per row instead: select only the columns you need, and shrink the wide ones (left(col, 2000), octet_length(col) or md5(col) in place of the value; a bytea column serialises as a JSON byte array roughly five times its size, so ask for encode(col,'base64') only when you really need the bytes). ${paging}`;
  }
  return `The ~${Math.round(MAX_RESULT_BYTES / 1000)} kB byte allowance for this tool call ran out after ${returned} row(s), which is why "returned" is below "row_count". Rows here are wide: select only the columns you need, and shrink the wide ones (left(col, 2000), octet_length(col) in place of the value; a bytea column serialises as a JSON byte array roughly five times its size). Raising max_rows will not help — the byte allowance bit first. ${paging}`;
}

/**
 * Wraps the statements of a batch and says, at the batch's own level, whether
 * the shared allowance ran out inside it.
 *
 * The statement that exhausted the budget reports its own truncation, but the
 * statements after it would otherwise be silent: they come back with an empty
 * `rows`, which reads exactly like a query that matched nothing. Each of them
 * does set `has_more` when rows were dropped, and the flags here say the
 * batch as a whole is short and where it stopped being complete.
 */
export function buildBatchEnvelope(statements: SqlResultEnvelope[]): MultiStatementEnvelope {
  const cutAt = statements.findIndex((statement) => statement.has_more);
  if (cutAt === -1) {
    return { statement_count: statements.length, batch_truncated: false, statements };
  }
  const reason = statements[cutAt]?.truncated_reason;
  return {
    statement_count: statements.length,
    batch_truncated: true,
    ...(reason === undefined ? {} : { truncated_reason: reason }),
    truncated_from_statement: cutAt + 1,
    truncation_note: `The row and byte allowance is shared by every statement of this call, and it ran out at statement ${cutAt + 1} of ${statements.length}. That statement, and every statement after it, returns fewer rows than the database produced — an empty "rows" beyond this point does NOT mean the statement matched nothing. Re-run the remaining statements one at a time, or add LIMIT clauses, to see the rest.`,
    statements,
  };
}

/**
 * Shapes one statement's kept rows into the envelope.
 *
 * Truncation is announced, never implied: `row_count` stays as PostgreSQL
 * counted it, `returned` says how many rows are actually here, `has_more`
 * plus `truncated_reason` say that the difference is this package's doing
 * rather than the query's, and `truncation_note` says what to do about it.
 * The budget was already spent in `take()` as the rows arrived — nothing is
 * cut here.
 */
export function buildEnvelope(statement: StatementRows, rowLimit: number): SqlResultEnvelope {
  const { result, rows, reason } = statement;
  // `pg` really does report `rowCount: null` — for `SET`, `BEGIN`, `DISCARD`
  // and every other command whose CommandComplete tag carries no count
  // (`Result.addCommandComplete`, pg 8.23 `lib/result.js:28`). Falling back
  // to the rows in hand keeps `row_count` a number rather than publishing a
  // null the model has to interpret.
  const rowCount = typeof result.rowCount === 'number' ? result.rowCount : rows.length;

  return {
    command: typeof result.command === 'string' ? result.command : null,
    row_count: rowCount,
    returned: rows.length,
    has_more: reason !== undefined,
    ...(reason === undefined
      ? {}
      : {
          truncated_reason: reason,
          truncation_note: truncationNote(reason, rows.length, rowLimit),
        }),
    fields: (result.fields ?? []).map((field) => ({
      name: field.name,
      data_type_id: field.dataTypeID,
    })),
    rows,
  };
}
