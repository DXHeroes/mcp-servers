/**
 * `PostgresClient` against a **real** PostgreSQL server — per-client parser
 * isolation, columns named `__proto__`, the scrubber on real rows, and whether
 * `readOnly` really cannot write.
 *
 * The four things a fixture cannot settle: whether `setTypeParser` on a
 * `pg.Client` stays on that client, what actually arrives for a column whose
 * name collides with `Object.prototype`, what the scrub does to a row that
 * carries the connector host's own credential, and which statements PostgreSQL itself
 * refuses inside `BEGIN READ ONLY`. Split out of `real-database.test.ts`,
 * which holds the type-OID table and the shared docs; the setup they have in
 * common lives in `real-database.helpers.ts`.
 *
 * **It never mocks `pg`.** The real driver, the real wire protocol.
 *
 * **It skips instead of failing when no database is reachable.**
 */
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_RESULT_BYTES, PostgresClient, PostgresError } from '../../src/client.js';
import {
  createHarness,
  credentialFor,
  HOST,
  MAINTENANCE_DATABASE,
  PASSWORD,
  SERVER_HOST,
  setUpDatabase,
  single,
  TEST_DATABASE,
  tearDownDatabase,
} from './real-database.helpers.js';

describe.skipIf(SERVER_HOST === null)('PostgresClient against a real PostgreSQL', () => {
  const host = HOST;
  const harness = createHarness();
  const { db, expectPostgresError } = harness;

  beforeAll(() => setUpDatabase(harness), 60_000);
  afterAll(() => tearDownDatabase(harness), 60_000);

  describe('two clients in one process', () => {
    it('keeps per-client type parsers from leaking between credentials', async () => {
      const onTestDb = new PostgresClient(credentialFor(host, TEST_DATABASE));
      const onMaintenance = new PostgresClient(credentialFor(host, MAINTENANCE_DATABASE));

      // `current_database()` is compared in SQL rather than returned: the
      // scrubber redacts the credential's password by value, and a common-word
      // password would be redacted out of a database name in the row.
      const first = single(
        await onTestDb.runSql({
          sql: `SELECT current_database() = '${TEST_DATABASE}' AS on_expected_db, '2024-06-01'::date AS d, ARRAY[0.10]::numeric[] AS n`,
        }),
      );
      const second = single(
        await onMaintenance.runSql({
          sql: `SELECT current_database() = '${MAINTENANCE_DATABASE}' AS on_expected_db, '2024-06-01'::date AS d, ARRAY[0.10]::numeric[] AS n`,
        }),
      );

      expect(first.rows[0]).toEqual({ on_expected_db: true, d: '2024-06-01', n: ['0.10'] });
      expect(second.rows[0]).toEqual({ on_expected_db: true, d: '2024-06-01', n: ['0.10'] });

      // Interleaved, so a client that had inherited the other's overrides (or
      // lost its own) would show up here rather than in whichever ran first.
      const again = single(await onTestDb.runSql({ sql: `SELECT '2024-06-01'::date AS d` }));
      expect(again.rows[0]).toEqual({ d: '2024-06-01' });
    });

    it('leaves the global pg.types table untouched', async () => {
      // `setTypeParser` on a `pg.Client` writes into that client's own
      // `TypeOverrides`. A global mutation would change how every other
      // PostgreSQL consumer in the process parses its rows. Read after the clients above have
      // run, so an override that had escaped would already be in place.
      type Oid = Parameters<typeof pg.types.getTypeParser>[0];
      const parsed: unknown = pg.types.getTypeParser(1082 as Oid)('2024-06-01');
      expect(parsed).toBeInstanceOf(Date);
      // And it is still the *broken* default, which is the point: the fix lives
      // on the client, and this is the value the package had to override. The
      // expectation is derived from the suite's pinned zone rather than written
      // out as Prague's June offset, so it stays a statement about the default
      // parser (local midnight, whatever local is) instead of a second,
      // silently zone-specific assertion inside a test named for something
      // else.
      expect((parsed as Date).toISOString()).toBe(new Date(2024, 5, 1).toISOString());
    });
  });

  /**
   * Column and `jsonb` key names are user data, and one of them collides with
   * `Object.prototype`.
   *
   * `SecretScrubber.scrub()` rebuilds every object key by key, and
   * `result['__proto__'] = value` on a plain `{}` runs the prototype setter
   * instead of creating an own property — so the column vanished from `rows`
   * while `fields` went on announcing it. Only a real server settles what
   * arrives here, which is why it is pinned in this file as well as in core's
   * own suite.
   */
  describe('a column named __proto__', () => {
    it('reaches the caller like any other column', async () => {
      const envelope = single(await db().runSql({ sql: 'SELECT 1 AS "__proto__", 2 AS ok' }));

      expect(envelope.fields.map((field) => field.name)).toEqual(['__proto__', 'ok']);
      // Compared through JSON: `toEqual` against an object literal cannot
      // express a `__proto__` own property at all.
      expect(JSON.stringify(envelope.rows)).toBe('[{"__proto__":1,"ok":2}]');
    });

    it('keeps a jsonb object under a __proto__ key', async () => {
      const envelope = single(
        await db().runSql({
          sql: "SELECT jsonb_build_object('__proto__', jsonb_build_object('polluted', true)) AS doc",
        }),
      );

      // This came back as `[{"doc":{}}]` — the nested object dropped whole.
      expect(JSON.stringify(envelope.rows)).toBe('[{"doc":{"__proto__":{"polluted":true}}}]');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('leaves Object.prototype alone for every other colliding name', async () => {
      const envelope = single(
        await db().runSql({ sql: 'SELECT 3 AS "constructor", 4 AS "toString", 5 AS ok' }),
      );
      expect(JSON.stringify(envelope.rows)).toBe('[{"constructor":3,"toString":4,"ok":5}]');
      expect({}.constructor).toBe(Object);
    });
  });

  describe('read-only enforcement', () => {
    // Starts with a row, so a refusal is distinguishable from a write that
    // landed and then errored.
    beforeEach(async () => {
      await db().runSql({ sql: 'CREATE TABLE ro (i int); INSERT INTO ro VALUES (1)' });
    });
    afterEach(async () => {
      await db().runSql({ sql: 'DROP TABLE IF EXISTS ro' });
    });

    async function rowsInRo(): Promise<number> {
      const envelope = single(await db().runSql({ sql: 'SELECT count(*)::int AS n FROM ro' }));
      return (envelope.rows[0] as { n: number }).n;
    }

    async function sqlstateOfRefusal(sql: string): Promise<string | undefined> {
      const error = await expectPostgresError(() => db().runSql({ sql, readOnly: true }));
      return error.sqlstate;
    }

    it('refuses every write and DDL, and nothing is written', async () => {
      // The table must exist: name resolution precedes the read-only check, so a
      // missing one answers `42P01` and passes for the wrong reason.
      for (const sql of [
        'INSERT INTO ro VALUES (2)',
        'UPDATE ro SET i = 1',
        'DELETE FROM ro',
        'TRUNCATE ro',
        'CREATE TABLE ro_ddl (i int)',
        'ALTER TABLE ro ADD COLUMN j int',
        'DROP TABLE ro',
        // Exempt from the write ban, not from the ban on CREATE — so the
        // temp-table carve-out is unreachable.
        'CREATE TEMPORARY TABLE ro_temp (i int)',
      ]) {
        expect(await sqlstateOfRefusal(sql), sql).toBe('25006');
      }
      expect(await rowsInRo()).toBe(1);
    });

    it('refuses a statement batch before any part of it runs', async () => {
      expect(await sqlstateOfRefusal('COMMIT; DELETE FROM ro')).toBe('42601');
      expect(await rowsInRo()).toBe(1);
    });

    it('leaves the write tool unaffected on the next call', async () => {
      await db().runSql({ sql: 'SELECT 1', readOnly: true });
      // A connection per call is what makes session-state tampering moot.
      await db().runSql({ sql: 'INSERT INTO ro VALUES (2)' });
      expect(await rowsInRo()).toBe(2);
    });

    it('still returns rows, with and without parameters', async () => {
      const series = 'SELECT i FROM generate_series(1, $1::int) AS i ORDER BY i';
      const withParams = single(await db().runSql({ sql: series, params: [3], readOnly: true }));
      expect(withParams.rows).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);

      // The call that would fall back without the explicit mode.
      const noParams = single(await db().runSql({ sql: 'SELECT 42 AS n', readOnly: true }));
      expect(noParams.rows).toEqual([{ n: 42 }]);
    });

    it('does NOT stop COPY TO PROGRAM, which the description says out loud', async () => {
      // An honest limit, not desired behaviour: what is pinned is that the
      // command is accepted. `42501` passes too — READ ONLY is not what refuses it.
      try {
        const envelope = single(
          await db().runSql({ sql: "COPY (SELECT 1) TO PROGRAM 'true'", readOnly: true }),
        );
        expect(envelope.command).toBe('COPY');
      } catch (error) {
        expect(error).toBeInstanceOf(PostgresError);
        expect((error as PostgresError).sqlstate).toBe('42501');
      }
    });
  });

  describe('scrubbing on real rows', () => {
    it('replaces the whole credential when it turns up inside a row value', async () => {
      // Value-based, not key-based: rows are the user's own data, so a column
      // called "password" is still returned — but the connector host's credential is
      // not relayed back, wherever it shows up. The full connection string and
      // the `user:password` segment are registered regardless of the password's
      // own shape, which is what makes this assertion true for any password.
      const credential = credentialFor(host, TEST_DATABASE);
      const envelope = single(
        await db().runSql({ sql: `SELECT 'in a row: ' || $1 AS v`, params: [credential] }),
      );
      const value = (envelope.rows[0] as Record<string, unknown> | undefined)?.v;
      expect(String(value)).not.toContain(credential);
      expect(value).toBe('in a row: [REDACTED-SECRET]');
    });

    it('returns a row the scrub shrinks back under the byte allowance', async () => {
      // The byte floor `spendOnRow` reads off the raw row is documented as a
      // **lower bound** on the shaped size, and the raw length is not one: the
      // scrub replaces every occurrence of the credential with the 17-byte
      // `[REDACTED-SECRET]`. Against this server the row below is 324,000 raw
      // bytes and 72,010 shaped ones under a 256,000-byte allowance, and the
      // raw floor refused it outright — `returned: 0`, `truncated_reason:
      // byte_limit`, an empty `rows` — which is silent data loss dressed as a
      // truncation.
      const credential = credentialFor(host, TEST_DATABASE);
      const envelope = single(
        await db().runSql({ sql: 'SELECT repeat($1 || $2, 4000) AS v', params: [credential, ' '] }),
      );

      expect(envelope.returned).toBe(1);
      expect(envelope.has_more).toBe(false);
      const value = String((envelope.rows[0] as Record<string, unknown> | undefined)?.v);
      // Raw it would not have fitted; scrubbed it does, and the raw size is
      // what the floor used to read.
      expect((credential.length + 1) * 4000).toBeGreaterThan(MAX_RESULT_BYTES);
      expect(Buffer.byteLength(value, 'utf8')).toBeLessThan(MAX_RESULT_BYTES);
      expect(value).not.toContain(credential);
    });

    it.skipIf(PASSWORD !== 'postgres')(
      'deliberately relays a single-character-class password like "postgres" verbatim',
      async () => {
        // Not an oversight — `valueScrubRefusal` refuses to scrub a password
        // that is all one character class, because `postgres` is both the most
        // common local password and an ordinary value in a user's own data (it
        // is what `SELECT datname FROM pg_database` returns, and it is a
        // plausible column name). Scrubbing it would rewrite the answer the
        // user asked for; a warning is logged instead. Only a real credential
        // against a real server exercises this, which is why it is pinned here
        // rather than trusted to a fixture.
        const envelope = single(
          await db().runSql({ sql: `SELECT 'x-' || $1 || '-x' AS v`, params: [PASSWORD] }),
        );
        expect((envelope.rows[0] as Record<string, unknown> | undefined)?.v).toBe(
          `x-${PASSWORD}-x`,
        );
      },
    );
  });
});
