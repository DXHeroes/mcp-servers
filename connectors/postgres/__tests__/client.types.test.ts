/**
 * `PostgresClient` — date and time type parsing, plus the guards for defects
 * that once survived the whole suite.
 *
 * Shared mocks, fixtures and hooks live in `./client.harness.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createDnsMock,
  createPgMock,
  expectPostgresError,
  loadClient,
  PUBLIC_URL,
  parseColumn,
  pgState,
  rejectionOf,
  setupHarness,
} from './client.harness.js';

vi.mock('pg', () => createPgMock());
vi.mock('node:dns/promises', () => createDnsMock());

const { PostgresClient, parseCredential } = await loadClient();

setupHarness();

describe('date and time type parsing', () => {
  /**
   * Zones with a non-zero offset in both directions, plus UTC.
   *
   * A parser that leaks the process offset is correct in exactly one of these,
   * and the suite's pinned zone (`vitest.config.ts`) is deliberately not that
   * one. `Pacific/Kiritimati` is +14:00, so a `date` parsed locally lands on
   * the *next* calendar day there and on the *previous* one in Prague — the two
   * directions of the same defect.
   */
  const ZONES = ['UTC', 'Europe/Prague', 'America/New_York', 'Pacific/Kiritimati'] as const;

  /**
   * Runs `body` with `TZ` set to `zone`, then restores it.
   *
   * Node re-reads `process.env.TZ` on assignment and notifies V8, so this
   * really does change how `new Date(...)` interprets a zone-less reading —
   * which is the whole mechanism under test.
   */
  async function withZone(zone: string, body: () => Promise<void>): Promise<void> {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      await body();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }

  /**
   * Rows built the way `pg` builds them: the raw column text run through the
   * parser resolved for its OID, which is the package's own override where it
   * registered one and `pg-types` for everything else. Registered as an
   * implementation rather than a value because the override only exists once
   * the client under test has been constructed.
   */
  function respondWith(columns: { name: string; oid: number; raw: string }[]) {
    pgState.query.mockImplementation(async () => ({
      command: 'SELECT',
      rowCount: 1,
      rows: [
        Object.fromEntries(
          columns.map((column) => [column.name, parseColumn(column.oid, column.raw)]),
        ),
      ],
      fields: columns.map((column) => ({ name: column.name, dataTypeID: column.oid })),
    }));
  }

  it('returns timestamp without time zone as the text PostgreSQL sent, with no zone implied', async () => {
    respondWith([{ name: 'created_at', oid: 1114, raw: '2024-06-01 12:00:00' }]);
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT created_at FROM t',
    })) as { rows: Record<string, unknown>[] };

    // Without the OID 1114 override `pg-types` builds a `Date` from the
    // process's local offset and `toJSON()` stamps a `Z` on it — the same
    // wall-clock reading served as a UTC instant, shifted by whatever `TZ` the
    // container runs in.
    expect(result.rows[0]?.created_at).toBe('2024-06-01 12:00:00');
    expect(String(result.rows[0]?.created_at)).not.toContain('Z');
  });

  it('leaves timestamptz as an ISO instant', async () => {
    respondWith([{ name: 'occurred_at', oid: 1184, raw: '2024-06-01 12:00:00+00' }]);
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT occurred_at FROM t',
    })) as { rows: Record<string, unknown>[] };

    // 1184 does denote a real instant, so its ISO string is correct in any
    // zone and is deliberately not overridden.
    expect(result.rows[0]?.occurred_at).toBe('2024-06-01T12:00:00.000Z');
  });

  it('returns timestamp[] elements as the text PostgreSQL sent, with no zone implied', async () => {
    respondWith([
      { name: 'readings', oid: 1115, raw: '{"2024-06-01 12:00:00","2024-12-31 23:59:59"}' },
    ]);
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT readings FROM t',
    })) as { rows: Record<string, unknown>[] };

    // Overriding OID 1114 does nothing for the elements of an array: `pg-types`
    // parses 1115 with a `parseDate` it holds internally, so without the 1115
    // override every element arrives as a `Date` built in the process's local
    // zone and `toJSON()` stamps a `Z` on it.
    expect(result.rows[0]?.readings).toEqual(['2024-06-01 12:00:00', '2024-12-31 23:59:59']);
    expect(JSON.stringify(result.rows[0]?.readings)).not.toContain('Z');
  });

  it('keeps the array grammar intact for a quoted element with a comma and for NULL', async () => {
    // The middle element is synthetic — PostgreSQL never puts a comma inside a
    // timestamp — and it is here on purpose: it is what tells a real delegation
    // to `postgres-array` (the parser `pg-types` itself uses for this OID)
    // apart from a hand-written split on commas, which would cut it in two.
    // `NULL` never reaches the element transform at all, so it must stay null
    // rather than become the string "NULL".
    respondWith([
      {
        name: 'readings',
        oid: 1115,
        raw: '{"2024-06-01 12:00:00","2024-06-02 08:30:00, give or take",NULL}',
      },
    ]);
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT readings FROM t',
    })) as { rows: Record<string, unknown>[] };

    expect(result.rows[0]?.readings).toEqual([
      '2024-06-01 12:00:00',
      '2024-06-02 08:30:00, give or take',
      null,
    ]);
  });

  it('leaves timestamptz[] as ISO instants', async () => {
    respondWith([
      {
        name: 'occurred_at',
        oid: 1185,
        raw: '{"2024-06-01 12:00:00+00","2024-06-02 06:15:00+00"}',
      },
    ]);
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT occurred_at FROM t',
    })) as { rows: Record<string, unknown>[] };

    // 1185 is left alone for the same reason 1184 is: those elements do denote
    // real instants, so their ISO strings are correct in any zone.
    expect(result.rows[0]?.occurred_at).toEqual([
      '2024-06-01T12:00:00.000Z',
      '2024-06-02T06:15:00.000Z',
    ]);
  });

  it('returns date as the calendar day PostgreSQL sent, not a local-midnight instant', async () => {
    respondWith([{ name: 'invoiced_on', oid: 1082, raw: '2024-06-01' }]);
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT invoiced_on FROM t',
    })) as { rows: Record<string, unknown>[] };

    // Without the OID 1082 override, `pg-types` builds a `Date` at *local*
    // midnight: under the suite's pinned `TZ=Europe/Prague` the day itself
    // changes, and the model is told 31 May for a row PostgreSQL stored as
    // 1 June. A date denotes a calendar day, never an instant.
    expect(result.rows[0]?.invoiced_on).toBe('2024-06-01');
    expect(String(result.rows[0]?.invoiced_on)).not.toContain('T');
  });

  it('returns date[] elements as calendar days, not local-midnight instants', async () => {
    respondWith([{ name: 'holidays', oid: 1182, raw: '{2024-06-01,2024-12-31,NULL}' }]);
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT holidays FROM t',
    })) as { rows: Record<string, unknown>[] };

    // 1182 needs its own override for the same reason 1115 does: `pg-types`
    // parses the elements with a `parseDate` reference it holds internally, so
    // the scalar override never reaches them. `NULL` still never reaches the
    // element transform.
    expect(result.rows[0]?.holidays).toEqual(['2024-06-01', '2024-12-31', null]);
  });

  for (const zone of ZONES) {
    it(`reports the same date and timestamp values under TZ=${zone}`, async () => {
      await withZone(zone, async () => {
        respondWith([
          { name: 'd', oid: 1082, raw: '2024-06-01' },
          { name: 'ds', oid: 1182, raw: '{2024-06-01}' },
          { name: 'ts', oid: 1114, raw: '2024-06-01 12:00:00' },
          { name: 'tss', oid: 1115, raw: '{"2024-06-01 12:00:00"}' },
          // The two that stay parsed: an instant is an instant everywhere, so
          // its ISO form must not move with the process zone either.
          { name: 'tstz', oid: 1184, raw: '2024-06-01 12:00:00+00' },
          { name: 'tstzs', oid: 1185, raw: '{"2024-06-01 12:00:00+00"}' },
          { name: 't', oid: 1083, raw: '12:00:00' },
          { name: 'ttz', oid: 1266, raw: '12:00:00+02' },
        ]);
        const result = (await new PostgresClient(PUBLIC_URL).runSql({
          sql: 'SELECT * FROM t',
        })) as { rows: Record<string, unknown>[] };

        expect(result.rows[0]).toEqual({
          d: '2024-06-01',
          ds: ['2024-06-01'],
          ts: '2024-06-01 12:00:00',
          tss: ['2024-06-01 12:00:00'],
          tstz: '2024-06-01T12:00:00.000Z',
          tstzs: ['2024-06-01T12:00:00.000Z'],
          t: '12:00:00',
          ttz: '12:00:00+02',
        });
      });
    });

    it(`reports the same interval value under TZ=${zone}`, async () => {
      await withZone(zone, async () => {
        // `interval` (1186) is left to `pg-types`, which parses it into a
        // `PostgresInterval` whose own enumerable fields are what serialises.
        // It carries no zone, so the process offset cannot reach it — pinned
        // here so that stays true rather than being assumed.
        respondWith([{ name: 'took', oid: 1186, raw: '1 day 02:03:04' }]);
        const result = (await new PostgresClient(PUBLIC_URL).runSql({
          sql: 'SELECT took FROM t',
        })) as { rows: Record<string, unknown>[] };

        expect(result.rows[0]?.took).toEqual({ days: 1, hours: 2, minutes: 3, seconds: 4 });
      });
    });
  }

  it('returns numeric[] elements as the exact text PostgreSQL sent, like scalar numeric', async () => {
    respondWith([
      { name: 'price', oid: 1700, raw: '0.10' },
      { name: 'prices', oid: 1231, raw: '{0.10,12345678901234567890.5}' },
    ]);
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT price, prices FROM t',
    })) as { rows: Record<string, unknown>[] };

    // `pg-types` leaves scalar `numeric` as exact text (arbitrary precision does
    // not survive a double) but parses `numeric[]` elements with `parseFloat` —
    // so `0.10` became `0.1` and the wide value lost digits outright, in the
    // same payload where the scalar column was exact.
    expect(result.rows[0]?.price).toBe('0.10');
    expect(result.rows[0]?.prices).toEqual(['0.10', '12345678901234567890.5']);
  });
});

/**
 * Guards for defects that survived the whole suite when they were introduced
 * deliberately — each of these four passed all 142 tests while broken, which
 * makes them the shape of defect this file is worst at catching.
 */
describe('regressions with no other guard', () => {
  it('keeps row_count a number when pg reports rowCount: null', async () => {
    // Not hypothetical: `Result.addCommandComplete` only sets `rowCount` when
    // the CommandComplete tag carries a count, so `SET`, `BEGIN`, `DISCARD`
    // and friends really do arrive as null. Publishing that null would make the
    // model interpret "the server did not say" as an answer.
    pgState.query.mockResolvedValue({
      command: 'SET',
      rowCount: null,
      rows: [{ a: 1 }, { a: 2 }],
      fields: [],
    });
    const result = (await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SET TIME ZONE UTC' })) as {
      row_count: number;
      returned: number;
    };

    expect(result.row_count).toBe(2);
    expect(result.returned).toBe(2);
  });

  it('does not mistake a Node errno for a SQLSTATE', async () => {
    // `EPERM` is five characters of [A-Z] and passes a naive
    // `/^[0-9A-Z]{5}$/` test, so without the "every SQLSTATE contains a digit"
    // guard it was reported as a PostgreSQL error code — a five-letter string
    // the caller would then look up in the SQLSTATE tables and never find.
    pgState.connect.mockRejectedValue(
      Object.assign(new Error('operation not permitted'), {
        code: 'EPERM',
      }),
    );
    const error = await rejectionOf(new PostgresClient(PUBLIC_URL).validateCredential());

    expect(error.sqlstate).toBeUndefined();
    expect(error.code).toBe('PG_ERROR');
  });

  it('leaves TLS out of the connection hint when sslmode=disable', async () => {
    pgState.connect.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    const error = await rejectionOf(
      new PostgresClient(
        'postgresql://alice:pw1234@db.example.com/shop?sslmode=disable',
      ).validateCredential(),
    );

    // `disable` asked for no TLS, so every sentence about TLS — attempted,
    // verified, or missing — is noise that sends the reader after a cause that
    // cannot exist here.
    const hint = error.hint ?? '';
    expect(hint).toBe(
      'The database did not answer. Check host, port, and that the connector host can reach it through the network.',
    );
    expect(hint).not.toContain('TLS');
    expect(hint).not.toContain('sslmode');
  });

  it('refuses a present-but-empty sslmode rather than defaulting it', () => {
    // `?sslmode=` and `sslmode=` are what an unsubstituted `${SSLMODE}` in a
    // Helm value or a rendered CI secret leaves behind, and reading them as the
    // documented default is a TLS posture nobody chose. libpq refuses an empty
    // `sslmode` too: a present one is validated against the accepted list, and
    // there is no "empty means default" rule for it.
    for (const credential of [
      'postgresql://a:pw1234@db.example.com/shop?sslmode=',
      'host=db.example.com dbname=shop user=alice sslmode=',
    ]) {
      const error = expectPostgresError(() => parseCredential(credential));
      expect(error.code, credential).toBe('INVALID_CREDENTIAL');
      expect(error.message, credential).toContain('present but empty');
    }

    // `sslrootcert=` stays unset, which is also libpq's behaviour for that one
    // — and unlike an empty sslmode it changes nothing about how the
    // connection is protected: the mode still verifies, against the system
    // store, and says so in the hint when it fails.
    expect(
      parseCredential('host=db.example.com dbname=shop user=alice sslrootcert=').sslrootcert,
    ).toBeUndefined();
  });
});
