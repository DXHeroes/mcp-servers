/**
 * `PostgresClient` — result buffering: the streaming contract that bounds how
 * much of a result set ever reaches memory.
 *
 * Shared mocks, fixtures and hooks live in `./client.harness.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createDnsMock,
  createPgMock,
  loadClient,
  PUBLIC_URL,
  pgState,
  rejectionOf,
  setupHarness,
} from './client.harness.js';

vi.mock('pg', () => createPgMock());
vi.mock('node:dns/promises', () => createDnsMock());

const { MAX_RESULT_BYTES, PostgresClient } = await loadClient();

setupHarness();

describe('result buffering', () => {
  function rows(count: number, fill = 'x') {
    return Array.from({ length: count }, (_, i) => ({ id: i, value: fill }));
  }

  it('streams rows instead of letting pg materialise the result set', async () => {
    await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT * FROM huge' });

    // The exact contract `pg` decides accumulation on
    // (`Query#handleRowDescription`: `this.callback || !this.listeners('row').length`).
    // Awaiting `client.query()` fails both halves of it — the promise API
    // assigns a callback — which is how one
    // `SELECT repeat('x',1000) FROM generate_series(1,5000000)` used to put the
    // entire result set in the connector host's heap before any budget was applied.
    // The mock assigns the callback exactly where `pg` does, so a
    // `query_timeout` back on the client config fails this line; the
    // real-driver test below is what proves the mock has that right.
    const submitted = pgState.submittables.at(-1);
    expect(submitted).toBeDefined();
    expect(submitted?.callback).toBeUndefined();
    expect(submitted?.listenerCount('row')).toBeGreaterThan(0);
    // And an 'error' listener, or an unhandled 'error' event throws out of
    // `emit` in a socket callback and takes the process with it.
    expect(submitted?.listenerCount('error')).toBeGreaterThan(0);
  });

  it('keeps query_timeout off the client, because pg would take the callback', async () => {
    // The one assertion in this file that uses the **real** driver, and it
    // exists because the mock cannot show this: `Client.query()` reads
    // `config.query_timeout || connectionParameters.query_timeout` and, when
    // either is set, assigns `query.callback` as its own clear-the-timer
    // wrapper (pg 8.23 `lib/client.js:733`). That one assignment does two
    // things — `Query#handleError` then routes to the callback and never emits
    // `'error'` (so a `SQL_ERROR` would leave the promise pending for ever and
    // the connection unclosed), and `Query#handleRowDescription` accumulates
    // every row again (so the memory bound is gone). Both were live, and both
    // were invisible against a mock `Client` that does not implement
    // `query_timeout`.
    const actual = await vi.importActual<typeof import('pg')>('pg');
    const RealClient = (actual.default ?? actual).Client;
    const RealQuery = (actual.default ?? actual).Query;

    function accumulatesAndSwallows(config: Record<string, unknown>): boolean {
      // Port 1 on purpose: nothing connects, and nothing needs to — the
      // callback is assigned by `query()` before the query is even queued.
      const client = new RealClient({ host: '127.0.0.1', port: 1, ...config });
      client.on('error', () => undefined);
      const query = new RealQuery({ text: 'SELECT 1' });
      query.on('row', () => undefined);
      query.on('error', () => undefined);
      client.query(query);
      // `@types/pg` does not declare `callback` on `Query`, but it is the field
      // `Query#handleRowDescription` and `#handleError` both branch on.
      const assigned = (query as unknown as { callback?: unknown }).callback;
      return Boolean(assigned) || query.listeners('row').length === 0;
    }

    expect(accumulatesAndSwallows({ query_timeout: 30_000 })).toBe(true);
    expect(accumulatesAndSwallows({})).toBe(false);
  });

  it('gives up on its own after the deadline when the server goes silent', async () => {
    vi.useFakeTimers();
    try {
      // A server that accepted the connection and then said nothing: no
      // SQLSTATE will ever arrive, so the client-side deadline is the only
      // thing that ends the tool call.
      pgState.query.mockReturnValue(new Promise(() => undefined));
      const promise = new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT pg_sleep(600)' });
      const settled = rejectionOf(promise);

      // The grace is pinned, not just the eventual timeout. The two used to be
      // the same number, which made them race: the client's deadline could
      // fire first and replace PostgreSQL's own `57014` — a real SQLSTATE with
      // a real message — with a bare "Query read timeout". At 31s the deadline
      // must therefore still be pending; advancing 33s in one step passes at
      // 30s and at 32s alike, which pins nothing.
      let done = false;
      void promise.catch(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      const error = await settled;

      expect(error.code).toBe('QUERY_TIMEOUT');
      // Two seconds past `statement_timeout`, so PostgreSQL's own 57014 wins
      // the race whenever the server is still talking.
      expect(error.hint).toContain('may still be running on the server');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps rows as a contiguous prefix once a statement has been cut', async () => {
    // The invariant the envelope's own wording depends on: `has_more` plus
    // `truncated_reason` say the rows are a prefix of the result and the *tail*
    // is missing. Without the "once cut, stays cut" guard, a wide row that
    // exhausts the budget is followed by narrower rows that still fit, so
    // `rows` comes back with a **hole in the middle** while the envelope claims
    // a clean cut — measured as `returned: 3` with the guard removed against
    // `returned: 1` with it.
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 4,
      rows: [
        { value: 'x'.repeat(200_000) },
        { value: 'y'.repeat(100_000) },
        { value: 'tail-a' },
        { value: 'tail-b' },
      ],
      fields: [],
    });
    const result = (await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' })) as {
      returned: number;
      has_more: boolean;
      truncated_reason: string;
      rows: { value: string }[];
    };

    // Row 2 did not fit; rows 3 and 4 would have, and must not be here.
    expect(result.returned).toBe(1);
    expect(result.rows.map((row) => row.value.slice(0, 6))).toEqual(['xxxxxx']);
    expect(result.has_more).toBe(true);
    expect(result.truncated_reason).toBe('byte_limit');
  });

  it('charges each row the separator byte it costs in the serialised array', async () => {
    // The `+ 1` in `take()` is what makes the byte budget the size of the
    // payload that actually goes out, commas included, rather than of the rows
    // in isolation. The row count here is chosen so the charge decides the
    // answer: 64 000 bytes per row against a 256 000-byte budget is exactly 4
    // rows without the separator and 3 with it (3 × 64 001 leaves 63 997,
    // which the fourth row cannot fit). Every other assertion in the suite
    // yields the same number either way.
    const perRow = 64_000;
    // `{"v":"` + payload + `"}` is 8 bytes of framing.
    const row = { v: 'a'.repeat(perRow - 8) };
    expect(Buffer.byteLength(JSON.stringify(row), 'utf8')).toBe(perRow);
    expect(MAX_RESULT_BYTES).toBe(perRow * 4);

    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 6,
      rows: Array.from({ length: 6 }, () => ({ ...row })),
      fields: [],
    });
    const result = (await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' })) as {
      returned: number;
      truncated_reason: string;
    };

    expect(result.returned).toBe(3);
    expect(result.truncated_reason).toBe('byte_limit');
  });

  it('never even serialises a row it is not going to keep', async () => {
    let touched = 0;
    const poison = {
      id: 3,
      get value(): string {
        touched += 1;
        return 'never read';
      },
    };
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 3,
      rows: [...rows(2), poison],
      fields: [],
    });
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT 1',
      maxRows: 2,
    })) as { returned: number; has_more: boolean };

    // Dropping a row must cost nothing: the row allowance is checked before the
    // row is shaped, so the third row is read off the socket and discarded
    // without being serialised, scrubbed or measured. This is the difference
    // between a cap and a slice.
    expect(result.returned).toBe(2);
    expect(result.has_more).toBe(true);
    expect(touched).toBe(0);
  });

  it('holds no more than the budget for a result far larger than it', async () => {
    // 50k rows of ~2 kB — ~100 MB if it were materialised — against the
    // ~256 kB byte allowance, which bites long before the 200-row one.
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 50_000,
      rows: rows(50_000, 'q'.repeat(2000)),
      fields: [],
    });
    const result = (await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT * FROM huge' })) as {
      row_count: number;
      returned: number;
      rows: unknown[];
      truncated_reason: string;
    };

    expect(result.row_count).toBe(50_000);
    expect(Buffer.byteLength(JSON.stringify(result.rows), 'utf8')).toBeLessThanOrEqual(
      MAX_RESULT_BYTES,
    );
    expect(result.truncated_reason).toBe('byte_limit');
  });

  /**
   * The byte budget is checked against the row's **raw** size before the row is
   * shaped, and these two tests are how that order is observable.
   *
   * Shaping costs a multiple of the row — serialise, parse, scrub, serialise —
   * so measuring first and refusing afterwards made one 20 MB `bytea` cost
   * ~480 MB of heap to discover it never fitted (a V8 abort under a 192 MB
   * heap). The discriminator here is a row that is both too wide *and*
   * unserialisable: shape-then-measure replaces it with
   * `ROW_NOT_SERIALISABLE` and keeps it (a small row, comfortably inside the
   * budget), while measuring the raw value first refuses it as `byte_limit`
   * and never touches it. So the outcome says which order ran.
   */
  it('never over-counts a Buffer, so a bytea that fits still comes back', () => {
    // The floor's *unsafe* direction, which nothing pinned: over-counting
    // refuses a row that fitted, and the refusal looks exactly like a genuine
    // one (`returned: 0`, `byte_limit`, an empty `rows`). A `bytea` is the case
    // to pin it on, because its length is deliberately counted in full — its
    // JSON form is roughly five times that, so the length is a safe floor, but
    // only as long as the multiplier is not applied twice.
    const blob = Buffer.alloc(30_000, 0xab);
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 1,
      rows: [{ blob }],
      fields: [{ name: 'blob', dataTypeID: 17 }],
    });
    return new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT blob FROM t' }).then((envelope) => {
      const result = envelope as { returned: number; has_more: boolean; rows: unknown[] };
      expect(result.returned).toBe(1);
      expect(result.has_more).toBe(false);
      // The row really is well inside the allowance, so nothing but an
      // inflated floor could have refused it — and it really is several times
      // its raw length, so the floor is not merely under-counting.
      const shaped = Buffer.byteLength(JSON.stringify(result.rows), 'utf8');
      expect(shaped).toBeLessThan(MAX_RESULT_BYTES);
      expect(shaped).toBeGreaterThan(blob.length * 3);
    });
  });

  it("reads the floor off array elements, not just the row's own columns", async () => {
    // `text[]`/`bytea[]` elements are where a whole column's bytes live, and
    // `rawRowFloor` walks one level into an array for exactly that reason. The
    // discriminator is the same one the two tests below use: the row is *also*
    // unserialisable, so shape-then-measure would replace it with a small
    // `ROW_NOT_SERIALISABLE` row and keep it, while reading the floor off the
    // element refuses it untouched.
    const row: Record<string, unknown> = { tags: ['x'.repeat(MAX_RESULT_BYTES + 1)] };
    row.self = row;
    pgState.query.mockResolvedValue({ command: 'SELECT', rowCount: 1, rows: [row], fields: [] });

    const result = (await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' })) as {
      returned: number;
      rows: unknown[];
      truncated_reason: string;
    };

    expect(result).toMatchObject({ returned: 0, truncated_reason: 'byte_limit' });
    expect(result.rows).toEqual([]);
  });

  it('measures a string after scrubbing it, so a row that fits is not dropped', async () => {
    // The floor is documented as a **lower bound** on the shaped size, and the
    // raw length is not one: `SecretScrubber` shrinks a string, replacing every
    // occurrence of the credential with the 17-byte `[REDACTED-SECRET]`.
    // Measured against PostgreSQL 17.11 as well as here — one `text` column
    // holding this 78-byte credential 4000 times over is 324,000 raw bytes and
    // 72,010 shaped bytes against a 256,000-byte allowance, and the raw floor
    // refused it with `returned: 0, truncated_reason: byte_limit`. Silent data
    // loss, from the optimisation that exists to avoid shaping rows that cannot
    // fit.
    const cell = `${PUBLIC_URL} `.repeat(4000);
    expect(Buffer.byteLength(cell, 'utf8')).toBeGreaterThan(MAX_RESULT_BYTES);
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 1,
      rows: [{ t: cell }],
      fields: [{ name: 't', dataTypeID: 25 }],
    });

    const result = (await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT t FROM t' })) as {
      returned: number;
      has_more: boolean;
      rows: Record<string, string>[];
    };

    expect(result.returned).toBe(1);
    expect(result.has_more).toBe(false);
    // And the row that came back is the scrubbed one: the credential is why it
    // fits, so it had better not be in the payload.
    expect(result.rows[0]?.t).not.toContain('sup3rsecret');
    expect(Buffer.byteLength(JSON.stringify(result.rows), 'utf8')).toBeLessThan(MAX_RESULT_BYTES);
  });

  for (const [label, wide] of [
    ['a text column', 'x'.repeat(MAX_RESULT_BYTES + 1)],
    // `bytea` arrives as a `Buffer`, and serialises as
    // `{"type":"Buffer","data":[…]}` — roughly five times its length, which is
    // why the length itself is a safe floor.
    ['a bytea column', Buffer.alloc(MAX_RESULT_BYTES + 1, 0x61)],
  ] as const) {
    it(`refuses an over-budget row from its raw size without shaping it — ${label}`, async () => {
      const row: Record<string, unknown> = { wide };
      row.self = row;
      pgState.query.mockResolvedValue({ command: 'SELECT', rowCount: 1, rows: [row], fields: [] });

      const result = (await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' })) as {
        row_count: number;
        returned: number;
        rows: unknown[];
        has_more: boolean;
        truncated_reason: string;
      };

      expect(result).toMatchObject({
        row_count: 1,
        returned: 0,
        has_more: true,
        truncated_reason: 'byte_limit',
      });
      expect(result.rows).toEqual([]);
    });
  }
});
