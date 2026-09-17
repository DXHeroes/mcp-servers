/**
 * `PostgresClient` against a **real** PostgreSQL server — type OIDs and value
 * shaping.
 *
 * Every other test in this package mocks `pg`, which is the right call for the
 * logic *around* the driver — but it leaves one whole class of defect
 * unobservable, and that class has already shipped twice: `date` (OID 1082)
 * reached the model shifted by a **whole calendar day** while all 142 unit
 * tests passed, because a mock decides for itself which OID it reports and what
 * the driver hands back for it. Neither fact was ever checked against a server.
 *
 * So this file asserts the two things only a real server can tell us:
 *
 * 1. which `data_type_id` actually arrives in `fields` for each type, and
 * 2. exactly what the value looks like after `runSql()` has shaped it —
 *    per-client type parsers, the JSON round trip in `shapeRow`, the scrubber.
 *
 * The rest of the real-database suite lives beside it, in
 * `real-database.budgets.test.ts` (the shared row/byte budget, `rowCount: null`
 * and the multi-statement protocol), `real-database.protocol.test.ts`
 * (parameterised queries, statement errors reaching the caller, PostgreSQL's
 * own SQLSTATEs) and `real-database.safety.test.ts` (parser isolation,
 * `__proto__` columns, scrubbing). All four share
 * `real-database.helpers.ts` — the server probe, the per-run throwaway
 * database and the raw-`pg` controls — and each creates and drops one database
 * of its own.
 *
 * **It never mocks `pg`.** The real driver, the real wire protocol.
 *
 * **It skips instead of failing when no database is reachable.**
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyForSweep,
  createHarness,
  LEGACY_TEST_DATABASE,
  SERVER_HOST,
  STALE_AFTER_SECONDS,
  setUpDatabase,
  single,
  TEST_DATABASE,
  TEST_DATABASE_PREFIX,
  tearDownDatabase,
} from './real-database.helpers.js';

/**
 * The sweep's safety property, pinned where **no** database is needed.
 *
 * Deliberately outside `describe.skipIf`: the question these answer is which
 * names the suite is willing to run `DROP DATABASE … WITH (FORCE)` on, and that
 * must be checked on every machine and in CI, not only where a server happens
 * to answer.
 */
describe('classifyForSweep', () => {
  const NOW = 1_800_000_000;
  const stamp = (secondsAgo: number): string =>
    `${TEST_DATABASE_PREFIX}${NOW - secondsAgo}_12345_ab12cd`;

  it('leaves a database it cannot prove is its own alone, however it looks', () => {
    for (const name of [
      // The one a real run dropped: every `_` of the prefix is a wildcard in a
      // LIKE pattern, and `data` parsed as NaN, which read as "legacy".
      'mcpxpostgresxpkgxtestxdata',
      'mcp_postgres_pkg_test_data',
      'mcp1postgres2pkg3test4whatever',
      // Right prefix, wrong shape — a human-named scratch database, or a
      // future revision's naming. Not datable, therefore not ours.
      `${TEST_DATABASE_PREFIX}scratch`,
      `${TEST_DATABASE_PREFIX}2024-01-01_1_a`,
      `${TEST_DATABASE_PREFIX}${NOW}`,
      `${TEST_DATABASE_PREFIX}${NOW}_12345`,
      `${TEST_DATABASE_PREFIX}${NOW}_12345_ab12cd_extra`,
      // Nothing to do with this suite at all.
      'mcp_connectors_test',
      'postgres',
      'template1',
    ]) {
      expect(classifyForSweep(name, NOW)).toBe('foreign');
    }
  });

  it('sweeps only its own names, and only once they are past the age guard', () => {
    expect(classifyForSweep(stamp(STALE_AFTER_SECONDS + 1), NOW)).toBe('stale');
    expect(classifyForSweep(stamp(STALE_AFTER_SECONDS), NOW)).toBe('stale');
    // A concurrent run's database is momentarily idle, not abandoned — and
    // `WITH (FORCE)` on it is the defect the per-run rename exists to fix.
    expect(classifyForSweep(stamp(STALE_AFTER_SECONDS - 1), NOW)).toBe('fresh');
    expect(classifyForSweep(stamp(0), NOW)).toBe('fresh');
  });

  it('sweeps the legacy fixed name whatever its age, and only that exact name', () => {
    expect(classifyForSweep(LEGACY_TEST_DATABASE, NOW)).toBe('stale');
    expect(classifyForSweep(`${LEGACY_TEST_DATABASE}x`, NOW)).toBe('foreign');
    expect(classifyForSweep(`x${LEGACY_TEST_DATABASE}`, NOW)).toBe('foreign');
  });

  it("classifies this run's own name as fresh", () => {
    // Belt and braces around the `row.datname === TEST_DATABASE` skip in the
    // sweep: even without it, a name minted seconds ago is never stale.
    expect(classifyForSweep(TEST_DATABASE, Date.now() / 1000)).toBe('fresh');
  });
});

describe.skipIf(SERVER_HOST === null)('PostgresClient against a real PostgreSQL', () => {
  const harness = createHarness();
  const { db, selectOne } = harness;

  beforeAll(() => setUpDatabase(harness), 60_000);
  afterAll(() => tearDownDatabase(harness), 60_000);

  it('runs in the non-UTC zone the suite is pinned to', () => {
    // Not decoration. Every local-offset defect in this package is invisible at
    // offset zero, so a run that lost `TZ` would prove nothing while looking
    // green — exactly the failure mode this file exists to end.
    expect(process.env.TZ).toBe('Europe/Prague');
  });

  /**
   * The OID-and-serialisation table.
   *
   * Both halves are the point: the OID is what the model sees in `fields` (and
   * what a mock previously made up), and the value is what `runSql` hands over
   * after the per-client type parsers and the JSON round trip in `shapeRow`.
   * Every OID below was observed against PostgreSQL 17 and matches the numbers
   * the package's comments claim.
   */
  describe('type OIDs and value shaping', () => {
    const cases: { label: string; expr: string; oid: number; value: unknown }[] = [
      { label: 'bool', expr: 'true::bool', oid: 16, value: true },
      { label: 'int2', expr: '1::int2', oid: 21, value: 1 },
      { label: 'int4', expr: '2::int4', oid: 23, value: 2 },
      {
        // `pg-types` parses int8 to a **string**, not a `BigInt` — which is why
        // digits past 2^53 survive, and why `jsonSafeValue`'s BigInt branch is
        // a guard against a custom parser rather than a path taken here.
        label: 'int8 past 2^53',
        expr: '9007199254740993::int8',
        oid: 20,
        value: '9007199254740993',
      },
      { label: 'numeric', expr: '0.10::numeric', oid: 1700, value: '0.10' },
      { label: 'numeric[]', expr: 'ARRAY[0.10]::numeric[]', oid: 1231, value: ['0.10'] },
      { label: 'float4', expr: '1.5::float4', oid: 700, value: 1.5 },
      { label: 'float8', expr: '1.5::float8', oid: 701, value: 1.5 },
      {
        // `JSON.stringify` renders every non-finite number as `null`, which the
        // model cannot tell from a SQL NULL. Confirmed against the server: the
        // driver really does hand over JS `NaN` here.
        label: "'NaN'::float8",
        expr: `'NaN'::float8`,
        oid: 701,
        value: 'NaN',
      },
      { label: "'Infinity'::float8", expr: `'Infinity'::float8`, oid: 701, value: 'Infinity' },
      { label: "'-Infinity'::float8", expr: `'-Infinity'::float8`, oid: 701, value: '-Infinity' },
      { label: 'text', expr: `'hi'::text`, oid: 25, value: 'hi' },
      { label: 'text[]', expr: `ARRAY['a','b']::text[]`, oid: 1009, value: ['a', 'b'] },
      {
        label: 'uuid',
        expr: `'0f8fad5b-d9cb-469f-a165-70867728950e'::uuid`,
        oid: 2950,
        value: '0f8fad5b-d9cb-469f-a165-70867728950e',
      },
      { label: 'json', expr: `'{"a":1}'::json`, oid: 114, value: { a: 1 } },
      { label: 'jsonb', expr: `'{"a":1}'::jsonb`, oid: 3802, value: { a: 1 } },
      {
        // `pg` parses bytea to a `Buffer`, and the JSON round trip turns that
        // into `{type,data}` — the ~5x inflation `truncation_note` warns about,
        // and the reason `shapeRow` must serialise before it scrubs (a
        // structural scrub of a `Buffer` would produce an index→byte map).
        label: 'bytea',
        expr: `'\\x0001ff'::bytea`,
        oid: 17,
        value: { type: 'Buffer', data: [0, 1, 255] },
      },
      { label: 'date', expr: `'2024-06-01'::date`, oid: 1082, value: '2024-06-01' },
      {
        label: 'date[]',
        expr: `ARRAY['2024-06-01','2024-12-31']::date[]`,
        oid: 1182,
        value: ['2024-06-01', '2024-12-31'],
      },
      {
        label: 'timestamp',
        expr: `'2024-06-01 12:34:56'::timestamp`,
        oid: 1114,
        value: '2024-06-01 12:34:56',
      },
      {
        label: 'timestamp[]',
        expr: `ARRAY['2024-06-01 12:34:56']::timestamp[]`,
        oid: 1115,
        value: ['2024-06-01 12:34:56'],
      },
      {
        // Deliberately NOT overridden: a timestamptz is a real instant, so the
        // ISO string `Date.toJSON()` produces is correct in any zone.
        label: 'timestamptz',
        expr: `'2024-06-01 12:34:56+00'::timestamptz`,
        oid: 1184,
        value: '2024-06-01T12:34:56.000Z',
      },
      {
        label: 'timestamptz[]',
        expr: `ARRAY['2024-06-01 12:34:56+00']::timestamptz[]`,
        oid: 1185,
        value: ['2024-06-01T12:34:56.000Z'],
      },
      { label: 'time', expr: `'12:34:56'::time`, oid: 1083, value: '12:34:56' },
      { label: 'timetz', expr: `'12:34:56+02'::timetz`, oid: 1266, value: '12:34:56+02' },
      {
        // `pg` parses interval into a `PostgresInterval`, whose `toJSON` keeps
        // only the non-zero components — an object, not a string, in the
        // payload the model reads.
        label: 'interval',
        expr: `'1 day 2 hours'::interval`,
        oid: 1186,
        value: { days: 1, hours: 2 },
      },
    ];

    for (const { label, expr, oid, value } of cases) {
      it(`returns ${label} as OID ${oid} and shapes the value exactly`, async () => {
        const observed = await selectOne(expr);
        expect(observed.oid).toBe(oid);
        expect(observed.value).toEqual(value);
      });
    }
  });

  /**
   * The defect that hid behind the mocks, pinned at the source.
   *
   * `pg-types` builds a `Date` for `date`/`timestamp` out of the **process's**
   * offset, so `Date.toJSON()` then reports an instant that was never claimed —
   * and for `date` the shift crosses a calendar day. Under `TZ=Europe/Prague`
   * (+02:00 in June) `'2024-06-01'::date` used to reach the model as
   * `"2024-05-31T22:00:00.000Z"`: the wrong day, in an authoritative-looking
   * payload, invisible in a UTC container.
   */
  describe('the date/timestamp local-offset defect', () => {
    it('returns date as the calendar day PostgreSQL sent, not the previous one', async () => {
      const { value } = await selectOne(`'2024-06-01'::date`);
      expect(value).toBe('2024-06-01');
      expect(value).not.toBe('2024-05-31T22:00:00.000Z');
      expect(String(value)).not.toContain('2024-05-31');
    });

    it('does not shift date[] elements either — the second half of the same bug', async () => {
      // Arrays needed their own override: `pg-types` parses every array OID
      // with a transform it holds internally, so a scalar override never
      // reaches the elements. `timestamp[]` stayed broken after `timestamp`
      // was fixed for exactly this reason.
      const { value } = await selectOne(`ARRAY['2024-06-01','2024-01-01']::date[]`);
      expect(value).toEqual(['2024-06-01', '2024-01-01']);
    });

    it('keeps a timestamp without time zone free of an invented Z', async () => {
      const { value } = await selectOne(`'2024-06-01 00:30:00'::timestamp`);
      // The dangerous case: the local-offset parse would move this reading to
      // the previous day as well (`2024-05-31T22:30:00.000Z`).
      expect(value).toBe('2024-06-01 00:30:00');
    });

    it('keeps timestamp[] elements free of one too', async () => {
      const { value } = await selectOne(`ARRAY['2024-06-01 00:30:00']::timestamp[]`);
      expect(value).toEqual(['2024-06-01 00:30:00']);
    });

    it('still reports timestamptz as a UTC instant', async () => {
      // The counter-test that keeps the fix from over-reaching: a timestamptz
      // *is* an instant, and normalising it to UTC is correct. A blanket
      // "return everything as text" would have regressed this to the server's
      // rendering in its own TimeZone setting.
      const { value } = await selectOne(`'2024-06-01 12:34:56+02'::timestamptz`);
      expect(value).toBe('2024-06-01T10:34:56.000Z');
    });

    it('shows both halves of the year, so a DST-only fix cannot pass', async () => {
      const envelope = single(
        await db().runSql({
          sql: `SELECT '2024-01-15'::date AS winter, '2024-07-15'::date AS summer`,
        }),
      );
      // Prague is +01:00 in January and +02:00 in July; a parser leaking either
      // offset moves one of these to the 14th.
      expect(envelope.rows[0]).toEqual({ winter: '2024-01-15', summer: '2024-07-15' });
    });
  });

  describe('numeric fidelity', () => {
    it('keeps the exact text of a numeric, trailing zero included', async () => {
      const { value } = await selectOne('0.10::numeric');
      expect(value).toBe('0.10');
    });

    it('keeps the exact text of numeric[] elements, matching the scalar', async () => {
      // `pg-types` parses numeric[] elements with `parseFloat`, so
      // `ARRAY[0.10]::numeric[]` came back as `[0.1]` in the same payload where
      // a `numeric` column was exact. Same value, two answers.
      const { value } = await selectOne('ARRAY[0.10]::numeric[]');
      expect(value).toEqual(['0.10']);
    });

    it('keeps every digit of a numeric past 2^53, in a scalar and in an array', async () => {
      const envelope = single(
        await db().runSql({
          sql: `SELECT 12345678901234567890.123::numeric AS scalar, ARRAY[12345678901234567890.123]::numeric[] AS arr`,
        }),
      );
      expect(envelope.rows[0]).toEqual({
        scalar: '12345678901234567890.123',
        // `parseFloat` would render this as 1.2345678901234567e+19.
        arr: ['12345678901234567890.123'],
      });
    });
  });
});
