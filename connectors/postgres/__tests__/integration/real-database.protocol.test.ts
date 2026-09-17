/**
 * `PostgresClient` against a **real** PostgreSQL server — parameterised
 * queries, statement errors reaching the caller, and PostgreSQL's own
 * SQLSTATEs.
 *
 * This is where the defect the real-database suite was written to find is
 * pinned: **a statement error never reached the caller at all**, because `pg`
 * assigns the submittable a callback of its own once `query_timeout` is set on
 * the client — which also defeated the row-streaming memory bound.
 * `createClient` therefore does not set `query_timeout` and the client-side
 * deadline lives in `streamStatements`; `statement errors reach the caller`
 * below keeps both the fixed behaviour and the two controls that show what
 * re-adding the option would cost.
 *
 * Split out of `real-database.test.ts`, which holds the type-OID table and the
 * shared docs; the setup they have in common lives in
 * `real-database.helpers.ts`.
 *
 * **It never mocks `pg`.** The real driver, the real wire protocol.
 *
 * **It skips instead of failing when no database is reachable.**
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresClient } from '../../src/client.js';
import {
  ABSENT_DATABASE,
  createHarness,
  credentialFor,
  HOST,
  HUNG_CALL_PROBE_MS,
  PASSWORD,
  SERVER_HOST,
  settleOutcome,
  setUpDatabase,
  single,
  TEST_DATABASE,
  tearDownDatabase,
  USER,
} from './real-database.helpers.js';

describe.skipIf(SERVER_HOST === null)('PostgresClient against a real PostgreSQL', () => {
  const host = HOST;
  const harness = createHarness();
  const { db, expectPostgresError, firstEventOf, rawClient, rawQueryError } = harness;

  beforeAll(() => setUpDatabase(harness), 60_000);
  afterAll(() => tearDownDatabase(harness), 60_000);

  describe('parameterised queries', () => {
    it('binds $1 through the extended protocol', async () => {
      const envelope = single(
        await db().runSql({ sql: 'SELECT $1::int AS v, $2::text AS t', params: [7, 'x'] }),
      );
      expect(envelope.rows).toEqual([{ v: 7, t: 'x' }]);
      expect(envelope.fields).toEqual([
        { name: 'v', data_type_id: 23 },
        { name: 't', data_type_id: 25 },
      ]);
    });

    it('keeps the type overrides on the extended protocol as well', async () => {
      // Worth its own test: the parsers are registered on the client, but a
      // parameterised call takes a different code path through `pg` than a
      // simple query, and the previous fixtures could not tell them apart.
      const envelope = single(
        await db().runSql({ sql: 'SELECT $1::date AS d', params: ['2024-06-01'] }),
      );
      expect(envelope.rows).toEqual([{ d: '2024-06-01' }]);
    });

    it('gets PostgreSQL refusing several commands in a prepared statement — 42601', async () => {
      // Not this package's rule: `params` forces the extended protocol, and
      // PostgreSQL itself rejects a multi-command prepared statement. Read
      // through the raw driver first, so the next test is asserting against an
      // error we have seen the server produce rather than one we assumed.
      const error = await rawQueryError('SELECT 1; SELECT 2', [1]);
      expect(error.code).toBe('42601');
      expect(error.message).toContain('cannot insert multiple commands into a prepared statement');
    });

    it('reports that refusal as SQL_ERROR with the server SQLSTATE', async () => {
      const error = await expectPostgresError(() =>
        db().runSql({ sql: 'SELECT 1; SELECT 2', params: [1] }),
      );
      expect(error.code).toBe('SQL_ERROR');
      expect(error.sqlstate).toBe('42601');
      expect(error.message).toContain('cannot insert multiple commands into a prepared statement');
    });
  });

  /**
   * **The defect this file found, and the reason it exists.**
   *
   * A statement error from PostgreSQL never reached the caller: `runSql` hung
   * for ever instead of rejecting with `SQL_ERROR`. Nothing about it was
   * observable with a mocked `pg` — worse, the unit suite asserted the
   * opposite was impossible, because its fake `Client.query()` did not
   * implement `query_timeout` and so the submittable it inspected still had no
   * callback.
   *
   * The cause is in `pg` 8.23 `lib/client.js:733`. `createClient` used to set
   * `query_timeout`, and for **any** query — a submittable included — `query()`
   * then does:
   *
   * ```js
   * const queryCallback = query.callback || (() => {})
   * const readTimeoutTimer = setTimeout(…, readTimeout)
   * query.callback = (err, res) => { clearTimeout(readTimeoutTimer); queryCallback(err, res) }
   * ```
   *
   * So the submittable `streamStatements` hands over — deliberately without a
   * callback — had one **assigned to it by the driver**, wrapping a noop. Two
   * consequences, both confirmed below against the real server:
   *
   * 1. `Query.handleError` routes an error to `this.callback` and emits
   *    `'error'` only when there is none, so the `'error'` listener
   *    `streamStatements` installs was never called: the promise stayed
   *    pending, `withConnection`'s `finally` never ran, and the connection
   *    leaked. The `QUERY_TIMEOUT` mapping was unreachable for the same
   *    reason — pg's own read-timeout error is delivered to that same noop.
   * 2. `Query.handleRowDescription` accumulates rows when
   *    `this.callback || !this.listeners('row').length` — and the callback was
   *    now truthy, so `pg` buffered the whole result set in `Query._result`
   *    regardless of the budget. The envelope stayed bounded; the heap did not.
   *
   * The fix is that `createClient` does not set `query_timeout` at all and the
   * client-side deadline lives in `streamStatements`. The two controls below
   * measure both consequences against the real driver, one with the option and
   * one without, so re-adding it fails here with the mechanism spelled out
   * rather than in a customer's process.
   */
  describe('statement errors reach the caller', () => {
    it('gets a real syntax error, with SQLSTATE 42601, from the server', async () => {
      // The error that exists and used to be lost. `hint` and `position` are on
      // it too, which is what `SQL_ERROR` relays.
      const error = await rawQueryError('SELEKT 1');
      expect(error.code).toBe('42601');
      expect(error.message).toContain('syntax error');
    });

    it('rejects with SQL_ERROR and the SQLSTATE the server sent', async () => {
      const error = await expectPostgresError(() => db().runSql({ sql: 'SELEKT 1' }));
      expect(error.code).toBe('SQL_ERROR');
      expect(error.sqlstate).toBe('42601');
      expect(error.message).toContain('syntax error');
      expect(error.hint).toContain('SQLSTATE');
    });

    it('settles at all — a hung promise is not a test failure by default', async () => {
      // The shape of the original defect: not a wrong answer, no answer. A
      // plain `expect(...).rejects` would have hung the worker rather than
      // failed, so the probe asserts that it settles *and* how.
      const outcome = await settleOutcome(
        () => db().runSql({ sql: 'SELEKT 1' }),
        HUNG_CALL_PROBE_MS,
      );
      expect(outcome).toBe('rejected');
    });

    it('delivers the error to the listener with the options createClient uses', async () => {
      // The contract `streamStatements` is written against, measured on the
      // real driver with the real client options.
      const client = await rawClient(TEST_DATABASE, { queryTimeout: false });
      try {
        const query = new pg.Query({ text: 'SELEKT 1' });
        query.on('row', () => undefined);
        expect(await firstEventOf(client, query, HUNG_CALL_PROBE_MS)).toBe('error:42601');
        // No callback was assigned, which is the difference.
        expect((query as unknown as { callback?: unknown }).callback).toBeUndefined();
      } finally {
        await client.end().catch(() => undefined);
      }
    });

    it('would have pg swallow the same error if query_timeout came back', async () => {
      // The negative control. A short `query_timeout` rather than the
      // package's 30s, so the timer it leaves behind has fired by the time the
      // test ends.
      const client = await rawClient(TEST_DATABASE, { queryTimeout: 400 });
      try {
        const query = new pg.Query({ text: 'SELEKT 1' });
        query.on('row', () => undefined);
        expect(await firstEventOf(client, query, HUNG_CALL_PROBE_MS)).toBe('none');
        // Assigned by `pg`, not by this package — this was the whole defect.
        expect(typeof (query as unknown as { callback?: unknown }).callback).toBe('function');
      } finally {
        await client.end().catch(() => undefined);
      }
    });

    it('keeps no rows in the driver with the options createClient uses', async () => {
      // The second consequence, measured: with no callback assigned, `pg`
      // parses each row, hands it to the listener and keeps **nothing**. This
      // is the row-streaming memory bound, observed on the driver's own
      // `Result` rather than inferred from the envelope.
      const client = await rawClient(TEST_DATABASE, { queryTimeout: false });
      try {
        const query = new pg.Query({
          text: `SELECT repeat('x', 100) AS w FROM generate_series(1, 20000)`,
        });
        let streamed = 0;
        query.on('row', () => {
          streamed += 1;
        });
        await new Promise<void>((resolve, reject) => {
          query.on('end', () => resolve());
          query.on('error', reject);
          client.query(query);
        });
        const accumulated = (query as unknown as { _result?: { rows?: unknown[] } })._result?.rows;
        expect(streamed).toBe(20_000);
        expect(accumulated?.length ?? 0).toBe(0);
      } finally {
        await client.end().catch(() => undefined);
      }
    }, 30_000);

    it('would have pg buffer every row if query_timeout came back', async () => {
      // The negative control for the same line: one assigned callback and the
      // budget bounds the envelope while the driver holds the whole result set.
      const client = await rawClient(TEST_DATABASE, { queryTimeout: 400 });
      try {
        const query = new pg.Query({
          text: `SELECT repeat('x', 100) AS w FROM generate_series(1, 20000)`,
        });
        let streamed = 0;
        query.on('row', () => {
          streamed += 1;
        });
        await new Promise<void>((resolve, reject) => {
          query.on('end', () => resolve());
          query.on('error', reject);
          client.query(query);
        });
        const accumulated = (query as unknown as { _result?: { rows?: unknown[] } })._result?.rows;
        expect(streamed).toBe(20_000);
        expect(accumulated?.length).toBe(20_000);
      } finally {
        await client.end().catch(() => undefined);
      }
    }, 30_000);
  });

  describe('error mapping from real server errors', () => {
    it('maps a rejected password to AUTH_FAILED without echoing the password', async () => {
      const wrong = 'definitely-not-the-password';
      const error = await expectPostgresError(() =>
        new PostgresClient(credentialFor(host, TEST_DATABASE, wrong)).runSql({ sql: 'SELECT 1' }),
      );
      expect(error.code).toBe('AUTH_FAILED');
      expect(error.sqlstate).toBe('28P01');
      expect(error.message).toContain('password authentication failed');
      // The scrubber is configured from the credential, so even a server that
      // quoted it back could not put it in front of the model.
      expect(error.message).not.toContain(wrong);
    });

    it('maps a nonexistent database to SQL_ERROR with SQLSTATE 3D000', async () => {
      // Observed, and worth stating because it is not the intuitive answer:
      // this is **not** CONNECTION_FAILED. The server answered — during the
      // startup exchange, but with a proper SQLSTATE — so `toPostgresError`
      // classifies it by SQLSTATE like any other server error. The hint the
      // caller gets therefore talks about fixing the SQL, which is the one
      // rough edge this test documents rather than asserts as ideal.
      const error = await expectPostgresError(() =>
        new PostgresClient(credentialFor(host, ABSENT_DATABASE)).runSql({ sql: 'SELECT 1' }),
      );
      expect(error.code).toBe('SQL_ERROR');
      expect(error.sqlstate).toBe('3D000');
      expect(error.message).toContain('does not exist');
    });

    it('maps an unreachable port to CONNECTION_FAILED', async () => {
      // Port 1 on the same (reachable) host: refused immediately, so this stays
      // fast and does not depend on a firewall dropping packets.
      const error = await expectPostgresError(() =>
        new PostgresClient(
          `postgresql://${USER}:${PASSWORD}@${host}:1/${TEST_DATABASE}?sslmode=disable`,
        ).runSql({ sql: 'SELECT 1' }),
      );
      expect(error.code).toBe('CONNECTION_FAILED');
      expect(error.sqlstate).toBeUndefined();
    });
  });
});
