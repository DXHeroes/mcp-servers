/**
 * Shared harness for the `PostgresClient` test files (`client.*.test.ts`).
 *
 * Holds the `pg` and DNS mocks, the fixtures every split file needs, and the
 * global `beforeEach`/`afterEach` reset. `vi.mock(...)` itself is hoisted per
 * module and cannot be shared through an import, so each test file repeats the
 * two `vi.mock` calls and points them at the factories exported here.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, type Mock, vi } from 'vitest';

export interface QueryResultLike {
  command?: string | null;
  rowCount?: number | null;
  rows?: unknown[];
  fields?: { name: string; dataTypeID: number }[];
}

export type TypeParser = (raw: string) => unknown;

export interface StatementShape {
  command: string | null;
  row_count: number;
  returned: number;
  has_more: boolean;
  truncated_reason?: string;
  rows: unknown[];
}

export interface BatchShape {
  statement_count: number;
  batch_truncated: boolean;
  truncated_reason?: string;
  truncated_from_statement?: number;
  truncation_note?: string;
  statements: StatementShape[];
}

interface PgState {
  configs: Record<string, unknown>[];
  /** The mock clients themselves, so a test can emit on one like `pg` does. */
  instances: EventEmitter[];
  /**
   * Per-client type-parser overrides, one map per constructed client, in
   * construction order — the mock's stand-in for `pg`'s own
   * `TypeOverrides` (`lib/client.js:77`, handed to every result at `:744`).
   * A test that cares how a column is parsed reads the last map and applies
   * it the way `pg` would, so the assertion is on the package's override and
   * not on a value the test made up.
   */
  typeParsers: Map<number, (raw: string) => unknown>[];
  /**
   * The submittables handed to `client.query()`, in order.
   *
   * `pg` only streams a query — instead of materialising every row first —
   * when the submittable has a `'row'` listener and **no** callback
   * (`lib/query.js:79`). That contract is the package's whole memory bound,
   * so the tests assert it on the object the package actually submits.
   */
  submittables: { callback?: unknown; listenerCount: (event: string) => number }[];
  /**
   * The config objects handed to `new pg.Query`, not the constructed `Query`:
   * only a config can show that a key was never set.
   */
  queryConfigs: { text: string; values?: unknown[]; queryMode?: string }[];
  connect: Mock<() => Promise<void>>;
  query: Mock<(...args: unknown[]) => Promise<QueryResultLike | QueryResultLike[]>>;
  end: Mock<() => Promise<void>>;
}

interface DnsState {
  lookup: Mock<(...args: unknown[]) => Promise<{ address: string; family: number }[]>>;
}

export const pgState: PgState = {
  configs: [],
  instances: [],
  typeParsers: [],
  submittables: [],
  queryConfigs: [],
  connect: vi.fn<() => Promise<void>>(),
  query: vi.fn<(...args: unknown[]) => Promise<QueryResultLike | QueryResultLike[]>>(),
  end: vi.fn<() => Promise<void>>(),
};

export const dnsState: DnsState = {
  lookup: vi.fn<(...args: unknown[]) => Promise<{ address: string; family: number }[]>>(),
};

interface MockQuery {
  text: string;
  values?: unknown[];
  queryMode?: string;
  emit: (event: string, ...args: unknown[]) => boolean;
}

/**
 * Whether the value is a `pg` submittable — the object form
 * `PostgresClient.streamStatements` hands to `client.query()`.
 */
function isSubmittable(value: unknown): value is MockQuery {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { submit?: unknown }).submit === 'function'
  );
}

/**
 * Replays a fixture into a submittable the way `pg`'s wire handlers do:
 * one `'row'` event per row *tagged with the `Result` its statement owns*,
 * then one `'end'` with the `Result` (or the array of them, for a
 * multi-statement text query — `pg` never builds a one-element array).
 *
 * This is what makes the streaming path testable at all. The package no
 * longer awaits `client.query()`, because a promise forces `pg` to buffer
 * the whole result set first; the fixtures stay in the same shape and the
 * mock turns them into the event sequence instead.
 */
function replay(query: MockQuery, raw: QueryResultLike | QueryResultLike[]): void {
  const list = Array.isArray(raw) ? raw : [raw];
  const results = list.map((result) => ({
    command: result.command ?? null,
    // Passed through untouched, `null` included: `pg` really reports
    // `rowCount: null` for a command whose tag carries no count.
    rowCount: result.rowCount,
    fields: result.fields ?? [],
  }));
  list.forEach((result, index) => {
    for (const row of result.rows ?? []) query.emit('row', row, results[index]);
  });
  query.emit('end', Array.isArray(raw) ? results : results[0]);
}

/**
 * The `pg` module replacement. A real `EventEmitter`, not a stub with an `on`
 * method: the socket-error test relies on Node's own "an unhandled 'error'
 * event throws" behaviour, which is exactly what escapes out of `pg` in
 * production.
 */
export function createPgMock() {
  return {
    default: {
      Query: class extends EventEmitter {
        readonly text: string;
        readonly values: unknown[] | undefined;
        readonly queryMode: string | undefined;
        constructor(config: { text: string; values?: unknown[]; queryMode?: string }) {
          super();
          this.text = config.text;
          this.values = config.values;
          this.queryMode = config.queryMode;
          pgState.queryConfigs.push(config);
        }
        submit(): void {
          // Driven by the mock `Client` below, exactly as `pg` drives it from
          // its connection handlers.
        }
      },
      Client: class extends EventEmitter {
        private readonly types = new Map<number, (raw: string) => unknown>();
        private readonly config: Record<string, unknown>;
        constructor(config: Record<string, unknown>) {
          super();
          this.config = config;
          pgState.configs.push(config);
          pgState.instances.push(this);
          pgState.typeParsers.push(this.types);
        }
        setTypeParser(
          oid: number,
          format: string | ((raw: string) => unknown),
          parseFn?: (raw: string) => unknown,
        ): void {
          const fn = typeof format === 'function' ? format : parseFn;
          if (fn !== undefined) this.types.set(oid, fn);
        }
        connect(): Promise<void> {
          return pgState.connect();
        }
        query(...args: unknown[]): unknown {
          const [first] = args;
          if (!isSubmittable(first)) return pgState.query(...args);
          // Faithful to `pg` in the one respect that matters here: a client
          // (or query) carrying `query_timeout` has `query.callback` assigned
          // by `query()` itself (pg 8.23 `lib/client.js:733`), which is what
          // silently turns row accumulation back on and stops the `'error'`
          // event from ever firing. A mock that skipped this reported the
          // streaming contract as satisfied while production buffered
          // everything, so it is reproduced rather than assumed away.
          if (this.config.query_timeout !== undefined) {
            (first as unknown as { callback?: unknown }).callback = () => undefined;
          }
          pgState.submittables.push(
            first as unknown as { listenerCount: (event: string) => number },
          );
          // The fixture is still asked for with the old `(sql, params?)` call
          // shape, so every assertion on `pgState.query`'s arguments keeps
          // meaning what it did.
          const fixture =
            first.values === undefined
              ? pgState.query(first.text)
              : pgState.query(first.text, first.values);
          fixture.then(
            (raw) => replay(first, raw),
            (error: unknown) => first.emit('error', error),
          );
          return first;
        }
        end(): Promise<void> {
          return pgState.end();
        }
      },
    },
  };
}

/** The `node:dns/promises` module replacement. */
export function createDnsMock() {
  return { lookup: (...args: unknown[]) => dnsState.lookup(...args) };
}

export const PUBLIC_URL = 'postgresql://alice:sup3rsecret@db.example.com:5432/shop?sslmode=require';

interface PgTypesShape {
  types: { getTypeParser: (oid: number) => TypeParser };
}

type ClientModule = typeof import('../src/client.js');

let clientModule: ClientModule | undefined;

/**
 * The real `pg-types` parser table, reached past the mock with `importActual`.
 *
 * The timestamp tests are driven by the parsing `pg` genuinely does — a
 * hand-written stand-in would pass whether or not the package registers its
 * override, which is the one thing those tests exist to prove.
 */
export let realPgTypes!: PgTypesShape['types'];

/**
 * The module under test, imported once the `vi.mock` factories above are
 * registered. Each test file awaits this at its top level instead of importing
 * `../src/client.js` directly, so the mock factories — which reach back into
 * this module — are never entered while this module is still evaluating.
 */
export async function loadClient(): Promise<ClientModule> {
  if (clientModule === undefined) {
    clientModule = await import('../src/client.js');
    const actualPg = await vi.importActual<PgTypesShape & { default?: PgTypesShape }>('pg');
    realPgTypes = (actualPg.default ?? actualPg).types;
  }
  return clientModule;
}

/**
 * One column value as `pg` would hand it to `buildEnvelope`: through the
 * override the package registered on the client under test if there is one, and
 * through the real `pg-types` parser for that OID otherwise — which is how
 * `TypeOverrides.getTypeParser` resolves a parser.
 */
export function parseColumn(oid: number, raw: string): unknown {
  const overrides = pgState.typeParsers.at(-1);
  const parser = overrides?.get(oid) ?? realPgTypes.getTypeParser(oid);
  return parser(raw);
}

/** The package's error class, once `loadClient()` has resolved. */
function postgresErrorClass(): ClientModule['PostgresError'] {
  if (clientModule === undefined) {
    throw new Error('loadClient() must be awaited before the error helpers are used.');
  }
  return clientModule.PostgresError;
}

/** Narrows a thrown value to the package's error, failing loudly otherwise. */
export function expectPostgresError(
  fn: () => unknown,
): InstanceType<ClientModule['PostgresError']> {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(postgresErrorClass());
    return error as InstanceType<ClientModule['PostgresError']>;
  }
  throw new Error('Expected the call to throw, but it did not.');
}

/**
 * The rejection reason, or a loud failure if the promise resolved.
 *
 * Asserting inside `promise.catch(cb)` is how a test stops testing anything:
 * once the promise resolves the callback never runs and the test is green. This
 * settles the promise first and fails on a resolution, so every assertion on the
 * error is reached or the test breaks.
 */
export async function rejectionOf(
  promise: Promise<unknown>,
): Promise<InstanceType<ClientModule['PostgresError']>> {
  const outcome = await promise.then(
    (value) => ({ rejected: false as const, value }),
    (error: unknown) => ({ rejected: true as const, error }),
  );
  if (!outcome.rejected) {
    throw new Error(
      `Expected the promise to reject, but it resolved with ${JSON.stringify(outcome.value)}.`,
    );
  }
  expect(outcome.error).toBeInstanceOf(postgresErrorClass());
  return outcome.error as InstanceType<ClientModule['PostgresError']>;
}

export async function expectRejectedWith(promise: Promise<unknown>, code: string) {
  expect((await rejectionOf(promise)).code).toBe(code);
}

/** The global reset every test file in this group shares. */
export function setupHarness(): void {
  let originalPolicy: string | undefined;

  beforeEach(() => {
    originalPolicy = process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS;
    delete process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS;
    pgState.configs.length = 0;
    pgState.instances.length = 0;
    pgState.typeParsers.length = 0;
    pgState.submittables.length = 0;
    pgState.queryConfigs.length = 0;
    pgState.connect.mockReset();
    pgState.connect.mockResolvedValue(undefined);
    pgState.end.mockReset();
    pgState.end.mockResolvedValue(undefined);
    pgState.query.mockReset();
    pgState.query.mockResolvedValue({ command: 'SELECT', rowCount: 0, rows: [], fields: [] });
    dnsState.lookup.mockReset();
    dnsState.lookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalPolicy === undefined) {
      delete process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS;
    } else {
      process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS = originalPolicy;
    }
    vi.restoreAllMocks();
  });
}
