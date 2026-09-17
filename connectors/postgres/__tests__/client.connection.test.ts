/**
 * `PostgresClient` — outbound network policy, connection lifecycle, and two
 * credentials alive in one process.
 *
 * Shared mocks, fixtures and hooks live in `./client.harness.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createDnsMock,
  createPgMock,
  dnsState,
  expectRejectedWith,
  loadClient,
  PUBLIC_URL,
  pgState,
  type QueryResultLike,
  realPgTypes,
  rejectionOf,
  setupHarness,
} from './client.harness.js';

vi.mock('pg', () => createPgMock());
vi.mock('node:dns/promises', () => createDnsMock());

const { PostgresClient } = await loadClient();

setupHarness();

describe('network policy', () => {
  const privateUrl = 'postgresql://alice:pw1234@internal.example.com/shop';

  it('allows a private address when the policy is unset', async () => {
    dnsState.lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(new PostgresClient(privateUrl).validateCredential()).resolves.toBeUndefined();
  });

  it('blocks the same private address when the policy is false', async () => {
    process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS = 'false';
    dnsState.lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expectRejectedWith(new PostgresClient(privateUrl).validateCredential(), 'BLOCKED_TARGET');
    expect(pgState.connect).not.toHaveBeenCalled();
  });

  it('blocks link-local and unspecified addresses under either policy', async () => {
    for (const policy of [undefined, 'false']) {
      for (const address of ['169.254.169.254', '0.0.0.0', 'fe80::1']) {
        if (policy === undefined) {
          delete process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS;
        } else {
          process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS = policy;
        }
        dnsState.lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
        await expectRejectedWith(
          new PostgresClient(privateUrl).validateCredential(),
          'BLOCKED_TARGET',
        );
      }
    }
  });

  it('blocks when only one of several resolved addresses is private', async () => {
    process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS = 'false';
    dnsState.lookup.mockResolvedValue([
      { address: '203.0.113.10', family: 4 },
      { address: '192.168.1.9', family: 4 },
    ]);
    await expectRejectedWith(new PostgresClient(privateUrl).validateCredential(), 'BLOCKED_TARGET');
  });

  it('checks an IP literal host without a DNS lookup', async () => {
    process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS = 'false';
    await expectRejectedWith(
      new PostgresClient('postgresql://alice:pw1234@10.1.2.3/shop').validateCredential(),
      'BLOCKED_TARGET',
    );
    expect(dnsState.lookup).not.toHaveBeenCalled();
  });

  it('reports a DNS failure as CONNECTION_FAILED', async () => {
    dnsState.lookup.mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND'), {
        code: 'ENOTFOUND',
      }),
    );
    await expectRejectedWith(
      new PostgresClient(privateUrl).validateCredential(),
      'CONNECTION_FAILED',
    );
  });

  it('reports an empty DNS answer as CONNECTION_FAILED', async () => {
    dnsState.lookup.mockResolvedValue([]);
    await expectRejectedWith(
      new PostgresClient(privateUrl).validateCredential(),
      'CONNECTION_FAILED',
    );
  });

  it('reads the policy per call, not once at import', async () => {
    dnsState.lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const client = new PostgresClient(privateUrl);
    await expect(client.validateCredential()).resolves.toBeUndefined();
    process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS = 'false';
    await expectRejectedWith(client.validateCredential(), 'BLOCKED_TARGET');
  });

  it('checks the target before every connection, not once per instance', async () => {
    const client = new PostgresClient(privateUrl);
    await client.runSql({ sql: 'SELECT 1' });
    await client.runSql({ sql: 'SELECT 2' });
    expect(dnsState.lookup).toHaveBeenCalledTimes(2);
  });

  it('refuses a host that turns private between two calls', async () => {
    process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS = 'false';
    dnsState.lookup.mockResolvedValueOnce([{ address: '203.0.113.10', family: 4 }]);
    dnsState.lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const client = new PostgresClient(privateUrl);
    await client.runSql({ sql: 'SELECT 1' });
    await expectRejectedWith(client.runSql({ sql: 'SELECT 2' }), 'BLOCKED_TARGET');
  });

  it('checks an IPv6 literal from the URL form without a DNS lookup', async () => {
    process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS = 'false';
    await expectRejectedWith(
      new PostgresClient('postgresql://alice:pw1234@[fd00::1]:5432/shop').validateCredential(),
      'BLOCKED_TARGET',
    );
    expect(dnsState.lookup).not.toHaveBeenCalled();
  });

  it('still accepts an IPv6 literal in the keyword form', async () => {
    process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS = 'false';
    await expectRejectedWith(
      new PostgresClient('host=::1 dbname=shop user=alice').validateCredential(),
      'BLOCKED_TARGET',
    );
    expect(dnsState.lookup).not.toHaveBeenCalled();
  });

  it('does not cache a DNS failure for the life of the instance', async () => {
    dnsState.lookup.mockRejectedValueOnce(new Error('temporary failure'));
    const client = new PostgresClient(privateUrl);
    await expectRejectedWith(client.validateCredential(), 'CONNECTION_FAILED');
    dnsState.lookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }]);
    await expect(client.validateCredential()).resolves.toBeUndefined();
  });
});

describe('connection lifecycle', () => {
  it('passes the server-side statement timeout and the connect timeout to pg', async () => {
    await new PostgresClient(PUBLIC_URL).validateCredential();
    expect(pgState.configs[0]).toMatchObject({
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      application_name: 'dxheroes-mcp-postgres',
    });
    // `query_timeout` must NOT be here, and the reason is not style. See the
    // real-`pg` contract test in `describe('result buffering')`: setting it
    // makes `Client.query()` assign `query.callback`, which both stops the
    // `'error'` event from ever firing (the promise never settles) and turns
    // row accumulation back on. The client-side deadline lives in
    // `streamStatements` instead.
    expect(pgState.configs[0]).not.toHaveProperty('query_timeout');
  });

  it('ends the connection even when the query throws', async () => {
    pgState.query.mockRejectedValue(Object.assign(new Error('syntax error'), { code: '42601' }));
    await expectRejectedWith(
      new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELCT 1' }),
      'SQL_ERROR',
    );
    expect(pgState.end).toHaveBeenCalledTimes(1);
  });

  it('ends a client whose connect() failed, rather than leaking its socket', async () => {
    // This used to be skipped on the grounds that there was nothing to close.
    // There is: `pg` has already opened the socket by the time the startup
    // exchange fails, and `Client.end()` on a client that never connected is a
    // documented no-op (8.23 `lib/client.js:785`). Verified against a server
    // that sends a startup `FATAL` and holds the socket open — ten failed
    // connects left ten sockets open, so that is one descriptor per tool call
    // leaked by the connector process.
    pgState.connect.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    await expectRejectedWith(
      new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' }),
      'CONNECTION_FAILED',
    );
    expect(pgState.end).toHaveBeenCalledTimes(1);
  });

  it('ends both clients when the cleartext retry fails too', async () => {
    // The retry path already ended the first client; it was the *last* failed
    // attempt that leaked, which is the one every failure ends on.
    pgState.connect.mockRejectedValueOnce(new Error('The server does not support SSL connections'));
    pgState.connect.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    await expectRejectedWith(
      new PostgresClient('postgresql://alice:pw1234@db.example.com/shop').runSql({
        sql: 'SELECT 1',
      }),
      'CONNECTION_FAILED',
    );
    expect(pgState.end).toHaveBeenCalledTimes(2);
  });

  it('destroys the socket when a graceful hang-up does not complete', async () => {
    // `Client.end()` resolves on the socket's 'close', which a server holding
    // its side open never sends — so awaiting it unbounded would hang the tool
    // call for ever, which is worse than the leak it replaced.
    vi.useFakeTimers();
    try {
      const destroy = vi.fn();
      pgState.end.mockReturnValue(new Promise(() => undefined));
      const instance = pgState.instances;
      const settled = new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' });
      // The client is built synchronously inside `withConnection`; give the
      // mocked connect/query microtasks a turn, then plant the stream `pg`
      // would have.
      await vi.advanceTimersByTimeAsync(0);
      Object.assign(instance[0] as object, { connection: { stream: { destroy } } });
      await vi.advanceTimersByTimeAsync(2_000);
      await settled;

      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the hang-up timer once the socket has closed', async () => {
    // The 2s bound is armed on every call, so a missing `clearTimeout` leaks a
    // live timer per tool call, each holding the event loop open for two more seconds and, in
    // a test worker, keeping the process from exiting.
    vi.useFakeTimers();
    try {
      await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' });
      // Nothing pending: neither the client-side read deadline nor the
      // hang-up bound.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never lets a failed hang-up replace the error that caused it', async () => {
    // The hang-up runs in a `finally`, so anything thrown there — `end()`
    // throwing synchronously, a `destroy()` that objects — takes the place of
    // the real failure and the caller is told about the socket instead of the
    // statement.
    pgState.end.mockImplementation(() => {
      throw new Error('hang-up exploded');
    });
    pgState.query.mockRejectedValue(
      Object.assign(new Error('relation "nope" does not exist'), {
        name: 'error',
        severity: 'ERROR',
        code: '42P01',
      }),
    );

    const error = await rejectionOf(new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' }));

    expect(error.code).toBe('SQL_ERROR');
    expect(error.sqlstate).toBe('42P01');
    expect(error.message).toContain('does not exist');
    expect(error.message).not.toContain('hang-up exploded');
  });

  it('still returns the result when the hang-up itself fails', async () => {
    // The other half: on the success path a throwing hang-up would turn a
    // finished statement into a rejected tool call.
    pgState.end.mockRejectedValue(new Error('hang-up exploded'));
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 1,
      rows: [{ a: 1 }],
      fields: [],
    });

    const result = (await new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT 1' })) as {
      rows: unknown[];
    };
    expect(result.rows).toEqual([{ a: 1 }]);
  });

  it('opens a fresh connection per call rather than pooling', async () => {
    const client = new PostgresClient(PUBLIC_URL);
    await client.runSql({ sql: 'SELECT 1' });
    await client.runSql({ sql: 'SELECT 2' });
    expect(pgState.configs).toHaveLength(2);
    expect(pgState.end).toHaveBeenCalledTimes(2);
  });

  it('absorbs a socket error emitted while a query is in flight', async () => {
    // `pg` emits 'error' on the Client when the socket dies mid-query — a
    // database restart, `pg_terminate_backend`, a NAT sending an RST. Node
    // throws an unhandled 'error' event out of `emit`, and in production that
    // throw happens inside a socket callback, i.e. as an `uncaughtException`
    // that can terminate the connector process and its other active calls.
    // Verified against real pg 8.23 —
    // `_handleErrorEvent` throws with no listener attached.
    let finishQuery: (result: QueryResultLike) => void = () => undefined;
    pgState.query.mockImplementation(
      () =>
        new Promise<QueryResultLike>((resolve) => {
          finishQuery = resolve;
        }),
    );
    const inFlight = new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELECT pg_sleep(1)' });
    await vi.waitFor(() => expect(pgState.instances).toHaveLength(1));
    const socket = Object.assign(new Error('socket died mid-query'), { code: 'ECONNRESET' });
    expect(() => pgState.instances[0]?.emit('error', socket)).not.toThrow();
    finishQuery({ command: 'SELECT', rowCount: 0, rows: [], fields: [] });
    await expect(inFlight).resolves.toMatchObject({ command: 'SELECT' });
  });

  it('does not let a failure to hang up mask the real error', async () => {
    pgState.query.mockRejectedValue(Object.assign(new Error('bad'), { code: '42601' }));
    pgState.end.mockRejectedValue(new Error('socket already gone'));
    await expectRejectedWith(
      new PostgresClient(PUBLIC_URL).runSql({ sql: 'SELCT 1' }),
      'SQL_ERROR',
    );
  });
});

/**
 * Two credentials alive in one process — the case the whole per-client
 * `setTypeParser` decision exists to protect.
 *
 * A connector process can hold multiple `PostgresClient`s, each with its own
 * credential. Nothing in the suite used to construct two, which is exactly the
 * arrangement a global `pg.types` mutation or a shared scrubber would break.
 */
describe('two credentials in one process', () => {
  const ALICE = 'postgresql://alice:Alice-pw-9182@alice-db.example.com/shop?sslmode=require';
  const BOB = 'postgresql://bob:Bob-pw-7766@bob-db.example.com/ledger?sslmode=disable';

  it('keeps each client on its own connection settings', async () => {
    await new PostgresClient(ALICE).validateCredential();
    await new PostgresClient(BOB).validateCredential();

    expect(pgState.configs).toHaveLength(2);
    expect(pgState.configs[0]).toMatchObject({
      host: 'alice-db.example.com',
      user: 'alice',
      database: 'shop',
      ssl: { rejectUnauthorized: false },
    });
    expect(pgState.configs[1]).toMatchObject({
      host: 'bob-db.example.com',
      user: 'bob',
      database: 'ledger',
      ssl: false,
    });
  });

  it('gives each client its own type-parser table', async () => {
    await new PostgresClient(ALICE).validateCredential();
    await new PostgresClient(BOB).validateCredential();

    expect(pgState.typeParsers).toHaveLength(2);
    // Distinct maps, both populated. One shared map would still pass a
    // single-client test and would mean one credential's parsing decisions
    // reached another user's rows.
    expect(pgState.typeParsers[0]).not.toBe(pgState.typeParsers[1]);
    for (const overrides of pgState.typeParsers) {
      expect(overrides.get(1082)).toBeDefined();
      expect(overrides.get(1114)).toBeDefined();
      expect(overrides.get(1231)).toBeDefined();
    }
  });

  it('never touches the process-wide pg-types table', async () => {
    await new PostgresClient(ALICE).validateCredential();
    await new PostgresClient(BOB).validateCredential();

    // A global `pg.types.setTypeParser` from here would change how other
    // PostgreSQL consumers in the process parse their rows.
    expect(realPgTypes.getTypeParser(1082)('2024-06-01')).toBeInstanceOf(Date);
    expect(realPgTypes.getTypeParser(1114)('2024-06-01 12:00:00')).toBeInstanceOf(Date);
  });

  it('scrubs each credential only out of its own results', async () => {
    const rowMentioningBoth = {
      note: 'alice used Alice-pw-9182 and bob used Bob-pw-7766',
    };
    pgState.query.mockResolvedValue({
      command: 'SELECT',
      rowCount: 1,
      rows: [rowMentioningBoth],
      fields: [],
    });

    const alice = (await new PostgresClient(ALICE).runSql({ sql: 'SELECT note FROM t' })) as {
      rows: Record<string, unknown>[];
    };
    const bob = (await new PostgresClient(BOB).runSql({ sql: 'SELECT note FROM t' })) as {
      rows: Record<string, unknown>[];
    };

    // Each scrubber knows one credential. Alice's own password must never
    // reach her result; Bob's is not hers to redact, and blanking it would be
    // this package inventing a change to her data.
    expect(String(alice.rows[0]?.note)).not.toContain('Alice-pw-9182');
    expect(String(alice.rows[0]?.note)).toContain('Bob-pw-7766');
    expect(String(bob.rows[0]?.note)).not.toContain('Bob-pw-7766');
    expect(String(bob.rows[0]?.note)).toContain('Alice-pw-9182');
  });
});
