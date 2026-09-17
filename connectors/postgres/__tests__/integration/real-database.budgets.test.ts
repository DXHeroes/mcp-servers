/**
 * `PostgresClient` against a **real** PostgreSQL server — the shared row/byte
 * budget, `rowCount: null`, and the multi-statement simple-query protocol.
 *
 * These behaviours used to be asserted against hand-written fixtures, so
 * nothing verified how much a real row costs, which commands really report no
 * count, or that `pg` hands over one `Result` per statement in a genuine
 * multi-statement text query. Split out of `real-database.test.ts`, which holds
 * the type-OID table and the shared docs; the setup they have in common lives
 * in `real-database.helpers.ts`.
 *
 * **It never mocks `pg`.** The real driver, the real wire protocol.
 *
 * **It skips instead of failing when no database is reachable.**
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_ROWS,
  HARD_MAX_ROWS,
  MAX_RESULT_BYTES,
  type SqlResultEnvelope,
} from '../../src/client.js';
import {
  batch,
  createHarness,
  SERVER_HOST,
  setUpDatabase,
  single,
  TEST_DATABASE,
  tearDownDatabase,
} from './real-database.helpers.js';

describe.skipIf(SERVER_HOST === null)('PostgresClient against a real PostgreSQL', () => {
  const harness = createHarness();
  const { db, rawClient } = harness;

  beforeAll(() => setUpDatabase(harness), 60_000);
  afterAll(() => tearDownDatabase(harness), 60_000);

  /**
   * `row_count` when PostgreSQL counts nothing.
   *
   * `pg` reports `rowCount: null` for every command whose CommandComplete tag
   * carries no count, and `buildEnvelope` falls back to the rows in hand so the
   * envelope never publishes a null the model has to interpret.
   */
  describe('commands that report no row count', () => {
    const commands: { sql: string; command: string }[] = [
      { sql: 'SET statement_timeout = 0', command: 'SET' },
      { sql: 'BEGIN', command: 'BEGIN' },
      { sql: 'DISCARD ALL', command: 'DISCARD' },
      { sql: 'CREATE TABLE row_count_probe (i int)', command: 'CREATE' },
    ];

    it('really does get rowCount: null from this server for each of them', async () => {
      // Asserted through the raw driver, once, so the fallback below is known
      // to be exercised rather than assumed. A connection per command, because
      // these commands interfere with each other on a shared one: `BEGIN`
      // opens a transaction, `DISCARD ALL` is then refused inside it (25001),
      // and everything after that is refused as well (25P02). That is also
      // exactly how `PostgresClient` runs them — one connection per call.
      for (const { sql, command } of commands) {
        const client = await rawClient(TEST_DATABASE);
        try {
          const result = await client.query(sql);
          expect({ sql, command: result.command, rowCount: result.rowCount }).toEqual({
            sql,
            command,
            rowCount: null,
          });
        } finally {
          await client.query('DROP TABLE IF EXISTS row_count_probe').catch(() => undefined);
          await client.end().catch(() => undefined);
        }
      }
    }, 30_000);

    for (const { sql, command } of commands) {
      it(`reports row_count as a number for "${sql}"`, async () => {
        const envelope = single(await db().runSql({ sql }));
        expect(envelope.command).toBe(command);
        expect(typeof envelope.row_count).toBe('number');
        expect(envelope.row_count).toBe(0);
        expect(envelope.returned).toBe(0);
        expect(envelope.has_more).toBe(false);
        expect(envelope.fields).toEqual([]);
        if (command === 'CREATE') {
          await db().runSql({ sql: 'DROP TABLE row_count_probe' });
        }
      });
    }
  });

  /**
   * The shared row/byte budget, against rows a server really produced.
   *
   * The fixtures for these used to be hand-built arrays, so nothing verified
   * how much a real row costs — nor that the budget is spent as rows *arrive*
   * rather than applied to a finished result set. The last test here is the
   * regression guard for that: a result buffered into the connector process's
   * heap can terminate the process instead of returning a truncated answer.
   */
  describe('budgets against real result sets', () => {
    it('cuts at max_rows and keeps the row count PostgreSQL reported', async () => {
      const envelope = single(
        await db().runSql({ sql: 'SELECT i FROM generate_series(1, 50) AS i', maxRows: 5 }),
      );
      expect(envelope.command).toBe('SELECT');
      expect(envelope.row_count).toBe(50);
      expect(envelope.returned).toBe(5);
      expect(envelope.rows).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }]);
      expect(envelope.has_more).toBe(true);
      expect(envelope.truncated_reason).toBe('row_limit');
      expect(envelope.truncation_note).toContain('max_rows');
    });

    it('caps a max_rows above the hard limit at the hard limit', async () => {
      const envelope = single(
        await db().runSql({
          sql: `SELECT i FROM generate_series(1, ${HARD_MAX_ROWS + 200}) AS i`,
          maxRows: HARD_MAX_ROWS + 500,
        }),
      );
      expect(envelope.row_count).toBe(HARD_MAX_ROWS + 200);
      expect(envelope.returned).toBe(HARD_MAX_ROWS);
      expect(envelope.truncated_reason).toBe('row_limit');
    });

    it('cuts on the byte budget before the row budget when rows are wide', async () => {
      // One row serialises as `{"w":"yyy…"}` — 6 bytes of framing, 10000 of
      // payload, 2 to close, plus the 1 `take()` charges for the comma. The
      // count is derived from the constant rather than written out, so the
      // assertion follows the budget if it is ever retuned.
      const perRow = 10_000 + 9;
      const envelope = single(
        await db().runSql({
          sql: `SELECT repeat('y', 10000) AS w FROM generate_series(1, 200)`,
          maxRows: 200,
        }),
      );
      expect(envelope.row_count).toBe(200);
      expect(envelope.returned).toBe(Math.floor(MAX_RESULT_BYTES / perRow));
      expect(envelope.returned).toBeLessThan(200);
      expect(envelope.has_more).toBe(true);
      expect(envelope.truncated_reason).toBe('byte_limit');
      expect(envelope.truncation_note).toContain('Raising max_rows will not help');
    });

    it('reports returned: 0 with row_count: 1 when one row alone busts the budget', async () => {
      // The case `max_rows` cannot fix, and the reason `truncation_note` is not
      // decoration: `rows` is empty while the query matched a row, which reads
      // exactly like "nothing found" unless the envelope says otherwise.
      const envelope = single(await db().runSql({ sql: `SELECT repeat('x', 300000) AS w` }));
      expect(envelope.row_count).toBe(1);
      expect(envelope.returned).toBe(0);
      expect(envelope.rows).toEqual([]);
      expect(envelope.has_more).toBe(true);
      expect(envelope.truncated_reason).toBe('byte_limit');
      expect(envelope.truncation_note).toContain('max_rows cannot help');
      expect(envelope.truncation_note).toContain('does NOT mean the query matched nothing');
    });

    it('bounds the envelope of a 200 MB result instead of relaying it', async () => {
      // 200 000 rows × ~1 kB is ~200 MB on the wire — the shape that used to
      // be ~5 GB of resident heap when `client.query(sql)` returned a
      // finished result. 200 000 rows keeps the test worth running (well
      // under a second of server time locally, measured); what is asserted
      // does not depend on the row count.
      //
      // This pins the **envelope**: bounded, and honest about being cut. It
      // does NOT prove the heap is bounded, and today it is not — `pg` buffers
      // every one of these rows in `Query._result`, because the driver assigns
      // the submittable a callback of its own. Measured directly in
      // `swallowed statement errors` below.
      const started = Date.now();
      const envelope = single(
        await db().runSql({
          sql: `SELECT repeat('x', 1000) AS w FROM generate_series(1, 200000)`,
        }),
      );
      expect(envelope.row_count).toBe(200_000);
      // The row allowance bites first here: ~1014 bytes per row means the
      // byte budget would allow ~252, and the default is 200.
      expect(envelope.returned).toBe(DEFAULT_MAX_ROWS);
      expect(envelope.has_more).toBe(true);
      expect(envelope.truncated_reason).toBe('row_limit');
      expect(Date.now() - started).toBeLessThan(30_000);
    }, 60_000);

    it('refuses a 20 MB bytea from its raw size instead of shaping it first', async () => {
      // The residual exposure of the streaming rewrite, and the one shape a
      // mock cannot show: `bytea` arrives as a `Buffer`, and shaping it means
      // stringify (a JSON byte array, ~5× the bytes) → parse (an array of
      // 20 million numbers) → scrub (a second copy) → stringify again. Measured
      // against this server before the fix: ~480 MB of peak heap for a row the
      // budget was always going to refuse, and a `FATAL ERROR: Ineffective
      // mark-compacts near heap limit` (exit 134) under
      // `--max-old-space-size=192`. After it: 56 MB of heapTotal, same
      // envelope.
      //
      // The envelope alone cannot tell the two apart — both report
      // `returned: 0` — so the peak heap during the call is what is asserted.
      // Sampled rather than read once at the end, because the whole point is a
      // transient allocation that GC then reclaims.
      let peak = 0;
      const sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().heapUsed);
      }, 10);
      let envelope: SqlResultEnvelope;
      try {
        envelope = single(
          await db().runSql({ sql: `SELECT repeat('a', 20 * 1024 * 1024)::bytea AS wide` }),
        );
      } finally {
        clearInterval(sampler);
      }

      expect(envelope.row_count).toBe(1);
      expect(envelope.returned).toBe(0);
      expect(envelope.truncated_reason).toBe('byte_limit');
      // Generous against GC noise and tight against the ~24× it used to cost:
      // the row is 20 MB on the wire, and the shaping path needed twenty times
      // that.
      expect(peak).toBeLessThan(200 * 1024 * 1024);
    }, 60_000);

    it('degrades a deeply nested jsonb row instead of taking the process down', async () => {
      // The regression this guard exists for, and it was a process kill, not a
      // bad answer. `SecretScrubber.scrubValue` recurses once per nesting
      // level with no depth cap, and it runs in `pg`'s `'row'` handler — which
      // `pg` calls from `handleDataRow` (8.23 `lib/query.js:96`), outside its
      // own try and inside a socket `data` callback. So the `RangeError`
      // became an `uncaughtException` and terminated the connector process.
      // Measured here at depth 1900, exit code 1. With a
      // handler installed the throw instead aborted pg's parse loop, so
      // `ReadyForQuery` never arrived and the tool call hung to the 32s client
      // deadline before reporting a `QUERY_TIMEOUT` that never happened.
      //
      // The depths straddle the window, because where it lands depends on how
      // much stack pg's own frames have already used: ~1500 comes back as the
      // value, ~1900 upwards as a replacement. Either is a pass — what is
      // pinned is that the call settles, settles *fast*, and that nothing
      // escapes.
      const escaped: unknown[] = [];
      const capture = (error: unknown) => escaped.push(error);
      process.on('uncaughtException', capture);
      process.on('unhandledRejection', capture);
      try {
        for (const depth of [1500, 1900, 2400, 5000]) {
          const started = Date.now();
          const envelope = single(
            await db().runSql({
              sql: `SELECT (repeat('[', ${depth}) || '1' || repeat(']', ${depth}))::jsonb AS deep`,
            }),
          );
          const row = envelope.rows[0] as Record<string, unknown> | undefined;
          expect(envelope.returned).toBe(1);
          // Never a hole in `rows`, and never the 32s deadline.
          expect(Date.now() - started).toBeLessThan(10_000);
          expect(row === undefined ? undefined : 'deep' in row || 'mcp_error' in row).toBe(true);
          if (row !== undefined && 'mcp_error' in row) {
            expect(row.mcp_error).toBe('ROW_NOT_SERIALISABLE');
          }
        }

        // And the connection is still usable afterwards: the guard replaces one
        // row, it does not poison the statement or the client.
        expect(single(await db().runSql({ sql: 'SELECT 1 AS ok' })).rows).toEqual([{ ok: 1 }]);
      } finally {
        process.off('uncaughtException', capture);
        process.off('unhandledRejection', capture);
      }
      expect(escaped).toEqual([]);
    }, 60_000);
  });

  /**
   * The multi-statement simple-query protocol, driven for real.
   *
   * `pg` reports one `Result` per statement only for a genuine multi-statement
   * text query, and `streamStatements` tells the statements apart by the
   * identity of the `Result` a row is tagged with — a contract the mock had to
   * imitate. This is it actually happening.
   */
  describe('multi-statement batches', () => {
    it('reports one envelope per statement, with each command and row count', async () => {
      const envelope = batch(
        await db().runSql({
          sql: [
            'CREATE TABLE batch_probe (i int)',
            'INSERT INTO batch_probe VALUES (1), (2), (3)',
            'UPDATE batch_probe SET i = i + 10 WHERE i > 1',
            'SELECT count(*)::int AS n FROM batch_probe',
            'DROP TABLE batch_probe',
          ].join('; '),
        }),
      );
      expect(envelope.statement_count).toBe(5);
      expect(envelope.batch_truncated).toBe(false);
      expect(
        envelope.statements.map((statement) => [statement.command, statement.row_count]),
      ).toEqual([
        // CREATE and DROP carry no count, so `row_count` falls back to 0.
        ['CREATE', 0],
        ['INSERT', 3],
        ['UPDATE', 2],
        ['SELECT', 1],
        ['DROP', 0],
      ]);
      expect(envelope.statements[3]?.rows).toEqual([{ n: 3 }]);
      // A statement that returned no rows still gets its envelope: it never
      // appears in the `'row'` stream at all, only in the `'end'` payload.
      expect(envelope.statements[0]?.fields).toEqual([]);
    });

    it('spends one budget across the batch and says where it ran out', async () => {
      const envelope = batch(
        await db().runSql({
          sql: [
            'SELECT i FROM generate_series(1, 10) AS i',
            'SELECT i FROM generate_series(11, 20) AS i',
            'SELECT 99 AS n',
          ].join('; '),
          maxRows: 12,
        }),
      );
      expect(envelope.statement_count).toBe(3);
      expect(envelope.batch_truncated).toBe(true);
      expect(envelope.truncated_reason).toBe('row_limit');
      expect(envelope.truncated_from_statement).toBe(2);
      expect(envelope.truncation_note).toContain('shared by every statement');

      // 12 rows for the whole call, not 12 per statement.
      expect(envelope.statements.map((statement) => statement.returned)).toEqual([10, 2, 0]);
      expect(envelope.statements.map((statement) => statement.row_count)).toEqual([10, 10, 1]);
      // The third statement matched a row and returned none of it. Without
      // `has_more` that is indistinguishable from a query that found nothing —
      // which is the whole reason the batch-level flags exist.
      expect(envelope.statements[2]?.has_more).toBe(true);
      expect(envelope.statements[2]?.rows).toEqual([]);
    });

    it('returns a single envelope, not a one-element batch, for one statement', async () => {
      // `pg` never builds a one-element array of results, so the statement
      // count is what distinguishes a batch — not a flag this package sets.
      const envelope = await db().runSql({ sql: 'SELECT 1 AS n' });
      expect('statements' in envelope).toBe(false);
    });
  });
});
