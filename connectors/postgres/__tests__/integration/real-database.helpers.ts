/**
 * Shared setup for the `real-database.*.test.ts` files.
 *
 * The suite that used to live in one `real-database.test.ts` is split across
 * several files (types, budgets, protocol, safety) so that neither the file nor
 * any one `describe` callback busts Biome's 500-line limits. Everything those
 * files have in common — the server probe, the per-run throwaway database, the
 * envelope helpers and the raw-`pg` controls — lives here, once, so it cannot
 * drift between them.
 *
 * Deliberately **not** named `*.test.ts`: Vitest must not pick this up as a
 * suite of its own.
 *
 * Each test file is its own module graph, so each gets its own `TEST_DATABASE`
 * name and creates/drops exactly one database of its own — which is the very
 * concurrency the per-run name was designed for.
 *
 * **It never mocks `pg`.** The real driver, the real wire protocol.
 *
 * **It skips instead of failing when no database is reachable.** CI runs
 * `pnpm test` (through `pnpm check`) with no service containers, so an
 * unreachable server has to be a skip, not a red build. Reachability is probed
 * once at module load with a short timeout; `POSTGRES_TEST_HOST` (plus
 * `_PORT`/`_USER`/`_PASSWORD`) overrides where to look.
 *
 * **It never touches another database.** It creates, and drops, one database of
 * its own; the maintenance database is used only to create/drop that one and to
 * prove two clients with different credentials do not leak parsers into each
 * other. Nothing else on the server is read or written.
 */
import { connect } from 'node:net';
import pg from 'pg';
import { expect } from 'vitest';
import {
  type MultiStatementEnvelope,
  PostgresClient,
  PostgresError,
  type SqlResultEnvelope,
} from '../../src/client.js';

/**
 * The connector host's default network policy, stated out loud.
 *
 * `PostgresClient.assertTargetAllowed()` refuses a private-network target when
 * `MCP_ALLOW_PRIVATE_NETWORK_TARGETS === 'false'`, and a local PostgreSQL is
 * always on a private address. The variable is read per call, so setting it
 * here (rather than depending on whatever the developer's shell exports) is
 * what keeps this file from failing for a reason that has nothing to do with
 * PostgreSQL. It is the documented default, not a relaxation.
 */
process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS = 'true';

/**
 * Prefix of the database this file creates and drops. Nothing else is written
 * to.
 */
export const TEST_DATABASE_PREFIX = 'mcp_postgres_pkg_test_';
/**
 * Database this run creates and drops — **unique per run**, and that is not
 * cosmetic.
 *
 * The name used to be the fixed literal `mcp_postgres_pkg_test`, dropped
 * `WITH (FORCE)` and recreated in `beforeAll`. Two runs at once (two developers
 * against a shared dev server, or one developer with a watch running plus a
 * `pnpm check`) destroyed each other: one lost the `CREATE` to
 * `duplicate key value violates unique constraint "pg_database_datname_index"`,
 * and the other took 60+ failures reading
 * `database "mcp_postgres_pkg_test" does not exist`, because `WITH (FORCE)`
 * terminated its sessions and dropped its database from under it mid-test.
 *
 * The seconds go first so a database left behind by a killed run can be swept
 * by age (see `dropStaleTestDatabases`) without any risk to a run in progress;
 * the pid and the random suffix are what make two runs starting in the same
 * second distinct.
 */
export const TEST_DATABASE = `${TEST_DATABASE_PREFIX}${Math.floor(Date.now() / 1000)}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
/**
 * The fixed name every run of this file used before the per-run rename.
 *
 * It can only be a leftover of the code that dropped and recreated it on every
 * run anyway, so it is swept whatever its age.
 */
export const LEGACY_TEST_DATABASE = TEST_DATABASE_PREFIX.replace(/_$/, '');

/**
 * Six hours: far longer than this suite can run, far shorter than a developer
 * will care about a database it forgot to drop.
 */
export const STALE_AFTER_SECONDS = 6 * 60 * 60;

/**
 * The shape `TEST_DATABASE` is built from — `<seconds>_<pid>_<suffix>` — as a
 * pattern, so a name this file did not write is never taken for one it did.
 */
const OWN_NAME_PATTERN = /^(\d{1,19})_\d{1,19}_[a-z0-9]{1,16}$/;

/**
 * What the sweep may do with a database it found on the server.
 *
 * `'foreign'` is the answer that matters, and the reason this is a named
 * function with tests of its own rather than three lines inside
 * `dropStaleTestDatabases`. The sweep runs `DROP DATABASE … WITH (FORCE)` on a
 * *shared* development server, so "is this one of mine?" is the whole safety
 * property, and it was wrong in two ways at once: the `LIKE` pattern treated
 * every `_` in the prefix as a wildcard, and a matched name whose first
 * segment was not a number parsed as `NaN` and was then classified as the
 * legacy fixed name — dropped **ignoring the age guard**. A database called
 * `mcpxpostgresxpkgxtestxdata` was dropped by a normal suite run.
 *
 * A name that starts with the prefix but is not shaped like one of ours is
 * therefore `'foreign'`: "not ours, leave it alone", never "old enough to be
 * legacy". Being unable to date a database is a reason to keep it, not to drop
 * it.
 */
export function classifyForSweep(
  datname: string,
  nowSeconds: number,
): 'stale' | 'fresh' | 'foreign' {
  if (datname === LEGACY_TEST_DATABASE) return 'stale';
  if (!datname.startsWith(TEST_DATABASE_PREFIX)) return 'foreign';
  const match = OWN_NAME_PATTERN.exec(datname.slice(TEST_DATABASE_PREFIX.length));
  if (match === null) return 'foreign';
  const stamp = Number(match[1]);
  return stamp <= nowSeconds - STALE_AFTER_SECONDS ? 'stale' : 'fresh';
}

/** Used only to CREATE/DROP the above, and as a second credential in one test. */
export const MAINTENANCE_DATABASE = 'postgres';
/** A name that must not exist, for the "nonexistent database" error mapping. */
export const ABSENT_DATABASE = 'mcp_absent_db_zz';

const PORT = Number(process.env.POSTGRES_TEST_PORT ?? '5432');
export const USER = process.env.POSTGRES_TEST_USER ?? 'postgres';
export const PASSWORD = process.env.POSTGRES_TEST_PASSWORD ?? 'postgres';

/**
 * Where to look for a server.
 *
 * `host.docker.internal` first because this package is developed in a
 * devcontainer, where the compose-managed PostgreSQL is on the host and
 * `localhost` is the container itself. An explicit `POSTGRES_TEST_HOST` wins,
 * which is also how the skip path is demonstrated (point it at an address
 * nothing answers on and the whole suite skips).
 */
const HOST_CANDIDATES =
  process.env.POSTGRES_TEST_HOST !== undefined && process.env.POSTGRES_TEST_HOST !== ''
    ? [process.env.POSTGRES_TEST_HOST]
    : ['host.docker.internal', 'localhost'];

/**
 * Short on purpose: this cost is paid by every `pnpm test` run on a machine
 * without a database, CI included, before anything is skipped.
 */
const PROBE_TIMEOUT_MS = 2_000;
/** Budget for the startup exchange once the port is known to be open. */
const HANDSHAKE_TIMEOUT_MS = 5_000;

/** `sslmode=disable` — a local development server has no TLS to negotiate. */
export function credentialFor(host: string, database: string, password = PASSWORD): string {
  return `postgresql://${USER}:${password}@${host}:${PORT}/${database}?sslmode=disable`;
}

/** Rejects rather than hanging, so an open port that is not PostgreSQL still skips. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * How long a call that should have failed gets to settle before it is taken as
 * pending for ever.
 *
 * Short, and it is not hypothetical: a statement error really did leave the
 * promise pending for ever until `query_timeout` came off the client — see
 * `statement errors reach the caller`. These probes are what would notice it
 * coming back, because a hung promise is not a test failure by default, it is a
 * test that never finishes asserting.
 */
export const HUNG_CALL_PROBE_MS = 1_500;

/** Whether a call settled inside `ms`, and how. */
export async function settleOutcome(
  run: () => Promise<unknown>,
  ms: number,
): Promise<'resolved' | 'rejected' | 'pending'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run().then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), ms);
        // The call being probed keeps its own connection and pg's read-timeout
        // timer alive; this one must not add to what holds the worker open.
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Whether something accepts a TCP connection on the port.
 *
 * Deliberately a raw socket rather than `PostgresClient`: the client's own
 * connect timeout is 10s, and an unroutable address would hold every `pnpm
 * test` run for that long before the suite could skip.
 */
function tcpReachable(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port: PORT });
    const settle = (reachable: boolean): void => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * The first candidate host that is a PostgreSQL admitting these credentials, or
 * `null`.
 *
 * The port probe alone is not enough — an open port proves nothing about the
 * protocol or the password — so a real `SELECT 1` through the package's own
 * client is what qualifies a host. Anything else is a skip.
 */
async function findServer(): Promise<string | null> {
  for (const host of HOST_CANDIDATES) {
    if (!(await tcpReachable(host))) continue;
    try {
      const client = new PostgresClient(credentialFor(host, MAINTENANCE_DATABASE));
      await withTimeout(client.validateCredential(), HANDSHAKE_TIMEOUT_MS);
      return host;
    } catch {
      // An open port that is not a PostgreSQL we can log into is not a failure
      // of this package; try the next candidate, then skip.
    }
  }
  return null;
}

// Top-level await: the suite has to know before `describe.skipIf` is evaluated.
export const SERVER_HOST = await findServer();

if (SERVER_HOST === null) {
  console.warn(
    `[postgres] No reachable PostgreSQL on ${HOST_CANDIDATES.join(', ')}:${PORT} as "${USER}" — the real-database integration suite is SKIPPED. Start one (docker compose up -d postgres) or set POSTGRES_TEST_HOST/_PORT/_USER/_PASSWORD to run it.`,
  );
}

/**
 * The reachable host, or `''`.
 *
 * Never read when the suite is skipped: `describe.skipIf` does not run the
 * body's hooks or tests. The fallback only satisfies the type.
 */
export const HOST = SERVER_HOST ?? '';

export function single(envelope: SqlResultEnvelope | MultiStatementEnvelope): SqlResultEnvelope {
  if ('statements' in envelope) {
    throw new Error(`Expected a single statement, got a batch of ${envelope.statement_count}.`);
  }
  return envelope;
}

export function batch(
  envelope: SqlResultEnvelope | MultiStatementEnvelope,
): MultiStatementEnvelope {
  if (!('statements' in envelope)) {
    throw new Error(`Expected a batch, got a single "${String(envelope.command)}" result.`);
  }
  return envelope;
}

/**
 * The per-run helpers every real-database file needs, bound to `HOST`.
 *
 * A factory rather than module-level functions so that a file which never
 * touches a server (and is therefore skipped) never builds them either.
 */
export function createHarness() {
  const host = HOST;

  /** A client on the throwaway database. One connection per call, as in production. */
  const db = (): PostgresClient => new PostgresClient(credentialFor(host, TEST_DATABASE));
  /** A client on the maintenance database — CREATE/DROP DATABASE only. */
  const admin = (): PostgresClient => new PostgresClient(credentialFor(host, MAINTENANCE_DATABASE));

  /** The one field's OID and the one column's shaped value, from `SELECT <expr> AS v`. */
  async function selectOne(expr: string): Promise<{ oid: number | undefined; value: unknown }> {
    const envelope = single(await db().runSql({ sql: `SELECT ${expr} AS v` }));
    expect(envelope.returned).toBe(1);
    return {
      oid: envelope.fields[0]?.data_type_id,
      value: (envelope.rows[0] as Record<string, unknown> | undefined)?.v,
    };
  }

  /** The `PostgresError` a call was expected to reject with. */
  async function expectPostgresError(run: () => Promise<unknown>): Promise<PostgresError> {
    try {
      await run();
    } catch (error) {
      if (error instanceof PostgresError) return error;
      throw error;
    }
    throw new Error('Expected the call to reject with a PostgresError, but it resolved.');
  }

  /**
   * A connected raw `pg.Client` with **`createClient`'s own options**.
   *
   * Only used where the package's behaviour has to be explained rather than
   * asserted — what the server really sends, and what `pg` does with it. The
   * options are copied deliberately: a control that differed in one of them
   * would prove nothing about production. `queryTimeout` is the one knob,
   * because it is the option that turns out to decide whether an error is
   * delivered at all.
   */
  async function rawClient(
    database: string,
    options: { queryTimeout?: number | false } = {},
  ): Promise<pg.Client> {
    const queryTimeout = options.queryTimeout ?? 30_000;
    const client = new pg.Client({
      host,
      port: PORT,
      user: USER,
      password: PASSWORD,
      database,
      ssl: false,
      application_name: 'dxheroes-mcp-postgres',
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      ...(queryTimeout === false ? {} : { query_timeout: queryTimeout }),
    });
    // The same absorbing listener `createClient` installs: an unhandled
    // 'error' on a `Client` throws out of `emit` in a socket callback.
    client.on('error', () => undefined);
    await client.connect();
    return client;
  }

  /** The error PostgreSQL itself reports for a statement, read through the promise API. */
  async function rawQueryError(
    sql: string,
    params?: unknown[],
  ): Promise<{ code: string; message: string }> {
    const client = await rawClient(TEST_DATABASE);
    try {
      await (params === undefined ? client.query(sql) : client.query(sql, params));
    } catch (error) {
      const { code } = error as { code?: string };
      if (typeof code === 'string') return { code, message: (error as Error).message };
      throw error;
    } finally {
      await client.end().catch(() => undefined);
    }
    throw new Error(`Expected PostgreSQL to reject: ${sql}`);
  }

  /** Which event a submittable emits first, or `'none'` inside `ms`. */
  function firstEventOf(client: pg.Client, query: pg.Query, ms: number): Promise<string> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve('none'), ms);
      timer.unref();
      query.on('error', (error: unknown) => {
        clearTimeout(timer);
        resolve(`error:${String((error as { code?: unknown }).code)}`);
      });
      query.on('end', () => {
        clearTimeout(timer);
        resolve('end');
      });
      client.query(query);
    });
  }

  /**
   * Removes databases this file left behind on an earlier, killed run.
   *
   * The per-run name means nothing self-heals any more — a run killed between
   * `CREATE` and `afterAll` leaves its database on the server for ever — so the
   * sweep is what replaces the old fixed name's one redeeming property. It is
   * bounded by **age**, never by "looks unused": a concurrent run's database
   * can be momentarily idle, and `WITH (FORCE)` on it is precisely the defect
   * this rename fixes. Six hours is far longer than this suite can run and far
   * shorter than a developer will care.
   *
   * The legacy fixed name is swept too: it can only be a leftover of the code
   * before this change, which dropped and recreated it on every run anyway.
   */
  async function dropStaleTestDatabases(): Promise<void> {
    const envelope = single(
      await admin().runSql({
        // `starts_with`, not `LIKE`: in a `LIKE` pattern `_` is a
        // single-character wildcard, so `'mcp_postgres_pkg_test_%'` also
        // matched `mcpXpostgresXpkgXtestXanything` — and a match whose stamp
        // segment was not a number parsed as `NaN`, which the old age test read
        // as "legacy" and dropped **regardless of age**. A database called
        // `mcpxpostgresxpkgxtestxdata` was really dropped by a normal run of
        // this suite. Two accidents hid how wide that was — a matched name with
        // a hyphen was a syntax error in the unquoted `DROP DATABASE`, and one
        // with a capital folded to a name that did not exist — and both were
        // swallowed by a bare `.catch()`.
        sql: 'SELECT datname FROM pg_database WHERE starts_with(datname, $1) OR datname = $2',
        params: [TEST_DATABASE_PREFIX, LEGACY_TEST_DATABASE],
      }),
    );
    for (const row of envelope.rows as { datname: string }[]) {
      if (row.datname === TEST_DATABASE) continue;
      if (classifyForSweep(row.datname, Date.now() / 1000) !== 'stale') continue;
      try {
        // Quoted, and safely so: `classifyForSweep` only says `'stale'` for a
        // name made of digits, lowercase letters and underscores, so there is
        // no quote to escape — the quoting is what stops a name this file did
        // not write from being read as SQL if that ever stops being true.
        await admin().runSql({ sql: `DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)` });
      } catch (error) {
        // Only the two races a concurrent run can genuinely lose are
        // tolerated. Everything else is re-thrown: a swallowed error here is
        // how a sweep that matched the wrong thing stayed invisible.
        const sqlstate = error instanceof PostgresError ? error.sqlstate : undefined;
        if (sqlstate !== '55006' && sqlstate !== '3D000') throw error;
      }
    }
  }

  return {
    db,
    admin,
    selectOne,
    expectPostgresError,
    rawClient,
    rawQueryError,
    firstEventOf,
    dropStaleTestDatabases,
  };
}

/** Everything `createHarness()` hands back, for the hook helpers below. */
export type RealDatabaseHarness = ReturnType<typeof createHarness>;

/** The `beforeAll` body every real-database file shares. */
export async function setUpDatabase(harness: RealDatabaseHarness): Promise<void> {
  await harness.dropStaleTestDatabases();
  // No DROP of our own name first: it is unique to this run, so there is
  // nothing of ours to collide with and nothing of anyone else's to force.
  await harness.admin().runSql({ sql: `CREATE DATABASE ${TEST_DATABASE}` });
}

/** The `afterAll` body every real-database file shares. */
export async function tearDownDatabase(harness: RealDatabaseHarness): Promise<void> {
  await harness.admin().runSql({ sql: `DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)` });
}
