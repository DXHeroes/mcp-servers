/**
 * `PostgresClient` — mapping driver failures onto the package's error, and
 * keeping the credential out of everything that error carries.
 *
 * Shared mocks, fixtures and hooks live in `./client.harness.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createDnsMock,
  createPgMock,
  dnsState,
  expectPostgresError,
  expectRejectedWith,
  loadClient,
  PUBLIC_URL,
  pgState,
  rejectionOf,
  setupHarness,
} from './client.harness.js';

vi.mock('pg', () => createPgMock());
vi.mock('node:dns/promises', () => createDnsMock());

const { PostgresClient, parseCredential } = await loadClient();

setupHarness();

describe('error mapping', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    [
      'invalid password',
      { code: '28P01', message: 'password authentication failed' },
      'AUTH_FAILED',
    ],
    ['invalid authorization', { code: '28000', message: 'no pg_hba.conf entry' }, 'AUTH_FAILED'],
    ['query cancelled', { code: '57014', message: 'canceling statement' }, 'QUERY_TIMEOUT'],
    ['syntax error', { code: '42601', message: 'syntax error at or near' }, 'SQL_ERROR'],
    [
      'connection refused',
      { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' },
      'CONNECTION_FAILED',
    ],
    ['broken pipe', { code: 'EPIPE', message: 'write EPIPE' }, 'CONNECTION_FAILED'],
    [
      'expired certificate',
      { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' },
      'CONNECTION_FAILED',
    ],
    ['unknown failure', { message: 'something else entirely' }, 'PG_ERROR'],
  ];

  for (const [label, shape, expected] of cases) {
    it(`maps ${label} to ${expected}`, async () => {
      pgState.query.mockRejectedValue(Object.assign(new Error(String(shape.message)), shape));
      await expectRejectedWith(
        new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' }),
        expected,
      );
    });
  }

  it('carries the SQLSTATE as its own field for a SQL error', async () => {
    pgState.query.mockRejectedValue(Object.assign(new Error('syntax error'), { code: '42601' }));
    const error = await rejectionOf(new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELCT 1' }));
    expect(error.sqlstate).toBe('42601');
    expect(error.message).not.toMatch(/^SQL_ERROR/);
  });

  it('rules TLS causes out of the hint when the mode negotiates', async () => {
    pgState.connect.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    const error = await rejectionOf(
      new PostgresClient('postgresql://alice:pw1234@db.example.com/shop').validateCredential(),
    );

    // The hint used to push `sslmode=require` at anyone on the default,
    // because `prefer` connected in cleartext and a TLS-only database refused
    // it. `prefer` now attempts TLS, so that advice would send the user after
    // a cause the mode has already excluded.
    expect(error.hint).not.toContain('Add sslmode=require');
    expect(error.hint).toContain('sslmode=prefer');
    expect(error.hint).toContain('TLS was attempted first');
  });

  it('does not push sslmode=require when TLS is already configured', async () => {
    pgState.connect.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    const hint =
      (await rejectionOf(new PostgresClient(PUBLIC_URL).validateCredential())).hint ?? '';
    expect(hint).not.toContain('Add sslmode=require');
    expect(hint).toContain('sslmode=require');
  });

  it('explains that a keyword value cannot contain a space', () => {
    const error = expectPostgresError(() =>
      parseCredential('host=db.example.com dbname=shop user=alice password=my pass'),
    );
    expect(error.code).toBe('INVALID_CREDENTIAL');
    expect(error.message).toContain('%20');
  });

  it('does not claim a timed-out statement was cancelled', async () => {
    pgState.query.mockRejectedValue(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    );
    const error = await rejectionOf(
      new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT pg_sleep(60)' }),
    );

    // `statement_timeout` is a session GUC the tool's own SQL can switch off,
    // and `query_timeout` only rejects the client-side promise — no
    // CancelRequest is ever sent. Promising a cancellation, and that nothing
    // uncommitted was applied, was a claim nothing in this package supports.
    expect(error.code).toBe('QUERY_TIMEOUT');
    expect(error.hint).not.toContain('was cancelled');
    expect(error.hint).toContain('may still be running on the server');
    expect(error.hint).toContain('pg_cancel_backend');
  });

  it('recognises a client-side query timeout without a SQLSTATE', async () => {
    pgState.query.mockRejectedValue(new Error('Query read timeout'));
    await expectRejectedWith(
      new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT pg_sleep(60)' }),
      'QUERY_TIMEOUT',
    );
  });

  it('includes detail and hint from PostgreSQL in the message', async () => {
    pgState.query.mockRejectedValue(
      Object.assign(new Error('relation "t" does not exist'), {
        code: '42P01',
        hint: 'Perhaps you meant "tt".',
      }),
    );
    const error = await rejectionOf(
      new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT * FROM t' }),
    );
    expect(error.message).toContain('Perhaps you meant');
  });
});

describe('secret scrubbing', () => {
  it('keeps the password out of error text that quotes it', async () => {
    pgState.query.mockRejectedValue(
      Object.assign(new Error('failed for connection sup3rsecret'), {
        code: '42601',
        detail: `connection string: ${PUBLIC_URL}`,
      }),
    );
    const { message } = await rejectionOf(
      new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' }),
    );
    expect(message).not.toContain('sup3rsecret');
    expect(message).not.toContain(PUBLIC_URL);
    expect(message).toContain('[REDACTED-SECRET]');
  });

  it('keeps the password out of a DNS failure message', async () => {
    dnsState.lookup.mockRejectedValue(new Error('lookup failed for sup3rsecret'));
    const error = await rejectionOf(
      new PostgresClient(
        'postgresql://alice:sup3rsecret@nope.example.com/shop',
      ).validateCredential(),
    );
    expect(error.message).not.toContain('sup3rsecret');
  });

  it('redacts the credential if it ever appears inside a returned row', async () => {
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 1,
      rows: [{ note: `see ${PUBLIC_URL} for details` }],
      fields: [],
    });
    const result = (await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT note FROM t' })) as {
      rows: { note: string }[];
    };
    expect(result.rows[0]?.note).not.toContain('sup3rsecret');
  });

  it('keeps a Date and a Buffer column intact while still scrubbing a string one', async () => {
    // `pg` parses timestamp/timestamptz/date to `Date` and bytea to `Buffer`.
    // A structural scrub over the raw driver rows rebuilds every object from
    // `Object.entries()`, which turns a `Date` (no own enumerable properties)
    // into `{}` and explodes a `Buffer` into an index→byte map — so the most
    // ordinary SELECT there is would silently lose its timestamps.
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 1,
      rows: [
        {
          created_at: new Date('2024-01-02T03:04:05.000Z'),
          blob: Buffer.from('hi'),
          n: 3,
          note: `see ${PUBLIC_URL} for details`,
        },
      ],
      fields: [],
    });
    const result = (await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT * FROM t' })) as {
      rows: Record<string, unknown>[];
    };
    const row = result.rows[0] ?? {};
    expect(row.created_at).toBe('2024-01-02T03:04:05.000Z');
    expect(row.blob).toEqual({ type: 'Buffer', data: [104, 105] });
    expect(row.n).toBe(3);
    expect(String(row.note)).not.toContain('sup3rsecret');
    expect(String(row.note)).toContain('[REDACTED-SECRET]');
  });

  it('does not redact a column merely because it is called password', async () => {
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 1,
      rows: [{ password: 'someone-elses-hash' }],
      fields: [],
    });
    const result = (await new PostgresClient(PUBLIC_URL).runSql({
      sql: 'SELECT password FROM t',
    })) as {
      rows: { password: string }[];
    };
    expect(result.rows[0]?.password).toBe('someone-elses-hash');
  });

  it('warns without publishing the shape of the password it refused', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Core's own floor is 8, and the local override used to be 4 — well inside
    // the range of a value that can plausibly *be* data.
    new PostgresClient('postgresql://alice:ab@db.example.com/shop');

    const message = String(warn.mock.calls.at(-1)?.[0] ?? '');
    // Actionable: the rule, and what would satisfy it.
    expect(message).toContain('not distinctive enough');
    expect(message).toContain('8 characters');
    expect(message).toContain('more than one character class');
    // But not *which* half of the rule this password failed. This line goes to
    // the shared host log, and in per-user mode the password is an end
    // user's own: "shorter than 8 characters" narrows a brute force for
    // anyone who can read operator logs.
    expect(message).not.toContain('is shorter than');
    expect(message).not.toContain('made of a single character class');
    expect(message).not.toContain('ab');
  });

  it('refuses to scrub a password by value when it is an ordinary word', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Eight characters, and also the answer to `SELECT datname FROM
    // pg_database` on every PostgreSQL instance there is. Registering it by
    // value would rewrite that cell — and any column *named* `postgres`,
    // because the scrubber redacts keys too — to `[REDACTED-SECRET]`.
    const client = new PostgresClient('postgresql://alice:postgres@db.example.com/shop');
    // Same wording as for a short password, deliberately: the log line names
    // the rule and not which half of it failed.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not distinctive enough'));

    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 1,
      rows: [{ datname: 'postgres', postgres: 'template1' }],
      fields: [],
    });
    return client.runSql({ sql: 'SELECT datname FROM pg_database' }).then((result) => {
      expect((result as { rows: Record<string, unknown>[] }).rows[0]).toEqual({
        datname: 'postgres',
        postgres: 'template1',
      });
    });
  });

  it('still scrubs a password that could not be data', async () => {
    const client = new PostgresClient('postgresql://alice:Hunter2-tunnel@db.example.com/shop');
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 1,
      rows: [{ note: 'the password is Hunter2-tunnel' }],
      fields: [],
    });
    const result = (await client.runSql({ sql: 'SELECT note FROM t' })) as {
      rows: Record<string, unknown>[];
    };
    expect(String(result.rows[0]?.note)).not.toContain('Hunter2-tunnel');
  });
});
