/**
 * `PostgresClient` — the result envelope it builds, the advice it attaches when
 * a result is truncated, and the values JSON cannot represent.
 *
 * Shared mocks, fixtures and hooks live in `./client.harness.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type BatchShape,
  createDnsMock,
  createPgMock,
  loadClient,
  PUBLIC_URL,
  pgState,
  setupHarness,
} from './client.harness.js';

vi.mock('pg', () => createPgMock());
vi.mock('node:dns/promises', () => createDnsMock());

const { MAX_RESULT_BYTES, PostgresClient } = await loadClient();

setupHarness();

describe('result envelope', () => {
  function rows(count: number, fill = 'x') {
    return Array.from({ length: count }, (_, i) => ({ id: i, value: fill }));
  }

  it('reports a full result without a truncation reason', async () => {
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 3,
      rows: rows(3),
      fields: [{ name: 'id', dataTypeID: 23 }],
    });
    const result = await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1', maxRows: 3 });
    expect(result).toMatchObject({
      command: 'SELECT',
      row_count: 3,
      returned: 3,
      has_more: false,
      fields: [{ name: 'id', data_type_id: 23 }],
    });
    expect(result).not.toHaveProperty('truncated_reason');
  });

  it('announces a row-limit truncation and keeps the real row count', async () => {
    pgState.query.mockResolvedValue({ command: 'SELECT', rowCount: 1240, rows: rows(1240) });
    const result = await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1', maxRows: 200 });
    expect(result).toMatchObject({
      row_count: 1240,
      returned: 200,
      has_more: true,
      truncated_reason: 'row_limit',
    });
  });

  it('defaults to 200 rows when no limit is asked for', async () => {
    pgState.query.mockResolvedValue({ command: 'SELECT', rowCount: 500, rows: rows(500) });
    const result = await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' });
    expect(result).toMatchObject({ returned: 200, truncated_reason: 'row_limit' });
  });

  it('caps max_rows at the hard limit', async () => {
    pgState.query.mockResolvedValue({ command: 'SELECT', rowCount: 5000, rows: rows(5000, 'y') });
    const result = await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1', maxRows: 4000 });
    // Pinned, not floored: `toBeLessThanOrEqual` also passes for 0 or 3, and
    // 5000 rows of ~22 bytes stay well under the byte cap, so the exact answer
    // is the hard limit itself.
    expect((result as { returned: number }).returned).toBe(1000);
  });

  it('announces a byte-limit truncation before the row limit is reached', async () => {
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 400,
      rows: rows(400, 'z'.repeat(1000)),
    });
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT 1',
      maxRows: 1000,
    })) as { returned: number; has_more: boolean; truncated_reason: string; rows: unknown[] };
    expect(result.has_more).toBe(true);
    expect(result.truncated_reason).toBe('byte_limit');
    expect(result.returned).toBeGreaterThan(0);
    expect(result.returned).toBeLessThan(400);
    expect(JSON.stringify(result.rows).length).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it('cuts at the real byte budget for multi-byte text, not at UTF-16 code units', async () => {
    // Each of these characters is three bytes in UTF-8 and one `String.length`
    // unit, so counting `.length` lets roughly three times the documented
    // budget through.
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 400,
      rows: rows(400, '\u017e'.repeat(1000)),
    });
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT 1',
      maxRows: 1000,
    })) as { returned: number; truncated_reason: string; rows: unknown[] };
    expect(result.truncated_reason).toBe('byte_limit');
    expect(result.returned).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result.rows), 'utf8')).toBeLessThanOrEqual(
      MAX_RESULT_BYTES,
    );
  });

  it('projects NaN and infinities to the spelling PostgreSQL uses, not to null', async () => {
    // `pg-types` parses float4/float8 with `parseFloat`, so 'NaN'::float8 and
    // 'Infinity'::float8 arrive as JS `NaN`/`Infinity` — and `JSON.stringify`
    // turns both into `null`, which the model cannot tell from a SQL NULL.
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 1,
      rows: [
        {
          nan: Number.NaN,
          pos: Number.POSITIVE_INFINITY,
          neg: Number.NEGATIVE_INFINITY,
          finite: 1.5,
          nothing: null,
        },
      ],
      fields: [],
    });
    const result = (await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' })) as {
      rows: Record<string, unknown>[];
    };
    expect(result.rows[0]).toEqual({
      nan: 'NaN',
      pos: 'Infinity',
      neg: '-Infinity',
      finite: 1.5,
      nothing: null,
    });
  });

  it('reports an affected-row count for a write', async () => {
    pgState.query.mockResolvedValue({ command: 'UPDATE', rowCount: 7, rows: [], fields: [] });
    const result = await new PostgresClient(PUBLIC_URL).runSql({ sql: 'UPDATE t SET a=1' });
    expect(result).toMatchObject({ command: 'UPDATE', row_count: 7, returned: 0, has_more: false });
  });

  it('reports every statement of a batch, not just the first', async () => {
    pgState.query.mockResolvedValue([
      { command: 'INSERT', rowCount: 1, rows: [], fields: [] },
      { command: 'SELECT', rowCount: 2, rows: rows(2), fields: [] },
    ]);
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'INSERT INTO t VALUES (1); SELECT * FROM t',
    })) as BatchShape;
    expect(result.statement_count).toBe(2);
    expect(result.statements.map((s) => s.command)).toEqual(['INSERT', 'SELECT']);
    // Nothing was cut, so the batch says so and carries none of the
    // truncation keys.
    expect(result.batch_truncated).toBe(false);
    expect(result).not.toHaveProperty('truncated_reason');
    expect(result).not.toHaveProperty('truncated_from_statement');
    expect(result).not.toHaveProperty('truncation_note');
  });

  it('shares one row budget across a batch instead of giving each statement its own', async () => {
    // 3 × 150 rows against a 200-row allowance. A per-statement budget returns
    // all 450 — the documented cap times the number of statements someone
    // happened to paste into one call.
    const statement = { command: 'SELECT', rowCount: 150, rows: rows(150), fields: [] };
    pgState.query.mockResolvedValue([statement, statement, statement]);
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT 1; SELECT 2; SELECT 3',
      maxRows: 200,
    })) as BatchShape;

    const returned = result.statements.reduce((sum, s) => sum + s.returned, 0);
    expect(returned).toBe(200);
    expect(result.statements.map((s) => s.returned)).toEqual([150, 50, 0]);
    expect(result.batch_truncated).toBe(true);
    expect(result.truncated_reason).toBe('row_limit');
    expect(result.truncated_from_statement).toBe(2);
    expect(result.truncation_note).toContain('statement 2 of 3');
    // The starved statement must not read as a genuinely empty result set.
    expect(result.statements[2]).toMatchObject({
      row_count: 150,
      returned: 0,
      has_more: true,
      truncated_reason: 'row_limit',
    });
  });

  it('shares one byte budget across a batch', async () => {
    // ~1 kB a row, 120 rows a statement: statement three is where ~256 kB runs
    // out. Per statement each of the three would be returned whole, ~367 kB.
    const statement = {
      command: 'SELECT',
      rowCount: 120,
      rows: rows(120, 'z'.repeat(1000)),
      fields: [],
    };
    pgState.query.mockResolvedValue([statement, statement, statement]);
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT 1; SELECT 2; SELECT 3',
      maxRows: 1000,
    })) as BatchShape;

    const totalBytes = result.statements.reduce(
      (sum, s) => sum + Buffer.byteLength(JSON.stringify(s.rows), 'utf8'),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(result.batch_truncated).toBe(true);
    expect(result.truncated_reason).toBe('byte_limit');
    expect(result.truncated_from_statement).toBe(3);
    expect(result.truncation_note).toContain('statement 3 of 3');
    expect(result.statements[0]?.returned).toBe(120);
    expect(result.statements[2]?.returned).toBeLessThan(120);
    expect(result.statements[2]?.has_more).toBe(true);
  });

  it('forwards parameters to pg instead of inlining them', async () => {
    await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT * FROM t WHERE a = $1',
      params: [42],
    });
    expect(pgState.query).toHaveBeenCalledWith('SELECT * FROM t WHERE a = $1', [42]);
  });
});

describe('truncation advice', () => {
  it('tells the caller how to page when the row allowance ran out', async () => {
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 900,
      rows: Array.from({ length: 900 }, (_, i) => ({ id: i })),
      fields: [],
    });
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT id FROM t',
      maxRows: 10,
    })) as { truncation_note?: string };

    expect(result.truncation_note).toContain('max_rows');
    expect(result.truncation_note).toContain('OFFSET');
  });

  it('says max_rows cannot help when one row alone blows the byte allowance', async () => {
    // The dead end this note exists for: `row_count: 1, returned: 0,
    // has_more: true, rows: []` and no way out. A single `bytea` gets here
    // easily — it serialises as `{"type":"Buffer","data":[…]}`, roughly five
    // times its size.
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 1,
      rows: [{ blob: 'b'.repeat(MAX_RESULT_BYTES + 1) }],
      fields: [{ name: 'blob', dataTypeID: 17 }],
    });
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT blob FROM t',
    })) as { row_count: number; returned: number; has_more: boolean; truncation_note?: string };

    expect(result).toMatchObject({ row_count: 1, returned: 0, has_more: true });
    const note = result.truncation_note ?? '';
    expect(note).toContain('max_rows cannot help');
    // An empty `rows` must not be readable as "the query matched nothing".
    expect(note).toContain('does NOT mean the query matched nothing');
    // And it has to name a way out, not just a diagnosis.
    expect(note).toContain('octet_length');
  });

  it('leaves the note off a result that was not truncated', async () => {
    const result = await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' });
    expect(result).not.toHaveProperty('truncation_note');
  });
});

describe('values JSON cannot represent', () => {
  it('serialises a BigInt as exact text instead of failing the whole call', async () => {
    pgState.query.mockResolvedValue([
      {
        command: 'SELECT',
        rowCount: 1,
        rows: [{ big: 9_007_199_254_740_993n, ok: 1 }],
        fields: [{ name: 'big', dataTypeID: 20 }],
      },
      { command: 'SELECT', rowCount: 1, rows: [{ other: 'still here' }], fields: [] },
    ]);
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT 1; SELECT 2',
    })) as BatchShape;

    // `JSON.stringify` throws on a BigInt, and thrown from the replacer that
    // used to escape as an opaque `PG_ERROR: Do not know how to serialize a
    // BigInt` — losing every other statement's result to report one column.
    expect(result.statements[0]?.rows[0]).toEqual({ big: '9007199254740993', ok: 1 });
    expect(result.statements[1]?.rows[0]).toEqual({ other: 'still here' });
  });

  it('replaces a row it cannot serialise at all and keeps the rest', async () => {
    const circular: Record<string, unknown> = { id: 1 };
    circular.self = circular;
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 2,
      rows: [circular, { id: 2 }],
      fields: [],
    });
    const result = (await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' })) as {
      returned: number;
      rows: Record<string, unknown>[];
    };

    expect(result.returned).toBe(2);
    expect(result.rows[0]?.mcp_error).toBe('ROW_NOT_SERIALISABLE');
    expect(String(result.rows[0]?.message)).toContain('cannot be represented in JSON');
    expect(result.rows[1]).toEqual({ id: 2 });
  });

  it('charges the replacement row to the budget like any other row', async () => {
    // The last-resort catch in `take()` used to subtract from `budget.bytes`
    // without checking what was left and without setting `collector.reason`, so
    // a result made entirely of rows it could not read walked straight past the
    // byte gate: measured at `returned: 1000`, 273,001 bytes of `rows`
    // (1.07× the documented ~256 kB cap) and `has_more: false` with no
    // `truncated_reason` — the envelope claiming a complete result it had
    // overrun the cap to produce.
    const rows = Array.from({ length: 1000 }, () => ({
      get boom(): never {
        throw new Error('property access exploded');
      },
    }));
    pgState.query.mockResolvedValue({ command: 'SELECT', rowCount: 1000, rows, fields: [] });

    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT * FROM t',
      maxRows: 1000,
    })) as {
      returned: number;
      has_more: boolean;
      truncated_reason: string;
      rows: unknown[];
    };

    expect(result.has_more).toBe(true);
    expect(result.truncated_reason).toBe('byte_limit');
    expect(result.returned).toBeLessThan(1000);
    // Inside the cap, and *exactly* as many rows as fit: one more would not,
    // which is what pins the `+ 1` byte per row in `UNSERIALISABLE_ROW_BYTES`.
    // Without it the accounting is a byte per row short, four more rows come
    // back, and the serialised array is past the cap the constant exists to
    // enforce.
    const first = result.rows[0];
    expect(Buffer.byteLength(JSON.stringify(result.rows), 'utf8')).toBeLessThanOrEqual(
      MAX_RESULT_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify([...result.rows, first]), 'utf8')).toBeGreaterThan(
      MAX_RESULT_BYTES,
    );
  });

  it('lets nothing at all escape the row listener, not even reading the row', async () => {
    // `take()` runs inside `pg`'s `'row'` handler, which `pg` calls from a
    // socket `data` callback — outside its own try, outside `withConnection`'s,
    // outside every promise. A throw there is an `uncaughtException` and the
    // host process exits. So the guard has to cover *everything* it does,
    // the property access included: this row throws before any serialisation
    // is attempted, which is where the byte-floor check reads its values.
    //
    // A guard, not a fail-first test: the outer catch in `take` exists for
    // paths that only came with the floor check. The regression it was written
    // for — a deep `jsonb` value overflowing the stack inside the scrubber —
    // needs the real driver's frames on the stack to reproduce and is pinned in
    // `__tests__/integration/real-database.test.ts`.
    const hostile = {
      id: 1,
      get boom(): never {
        throw new Error('property access exploded');
      },
    };
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 2,
      rows: [hostile, { id: 2 }],
      fields: [],
    });

    const escaped: unknown[] = [];
    const capture = (error: unknown) => escaped.push(error);
    process.on('uncaughtException', capture);
    process.on('unhandledRejection', capture);
    try {
      const result = (await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' })) as {
        returned: number;
        has_more: boolean;
        rows: Record<string, unknown>[];
      };

      // Replaced, not dropped: `returned` below `row_count` with
      // `has_more: false` is the envelope lying about a complete result.
      expect(result.returned).toBe(2);
      expect(result.has_more).toBe(false);
      expect(result.rows[0]?.mcp_error).toBe('ROW_NOT_SERIALISABLE');
      expect(result.rows[1]).toEqual({ id: 2 });
    } finally {
      process.off('uncaughtException', capture);
      process.off('unhandledRejection', capture);
    }
    expect(escaped).toEqual([]);
  });
});
