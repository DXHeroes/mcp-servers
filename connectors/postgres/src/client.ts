import { SecretScrubber } from '@dxheroes/mcp-kit';
import pg from 'pg';
import { withConnection } from './connection.js';
import { type ConnectionTarget, parseCredential } from './credential.js';
import {
  CLIENT_DEADLINE_GRACE_MS,
  DEFAULT_MAX_ROWS,
  HARD_MAX_ROWS,
  MAX_RESULT_BYTES,
  STATEMENT_TIMEOUT_MS,
} from './limits.js';
import {
  buildBatchEnvelope,
  buildEnvelope,
  type MultiStatementEnvelope,
  type ResultBudget,
  type SqlResultEnvelope,
  type StatementRows,
} from './result-envelope.js';
import { take } from './row-budget.js';

// Everything this module used to declare itself stays importable from
// `./client.js`. The file was split for size alone, so the surface it presents
// is unchanged and no caller — or test — has to know where a symbol now lives.
export { type ConnectionTarget, parseCredential } from './credential.js';
export { CREDENTIAL_FORMAT_HELP, type SslMode } from './credential-fields.js';
export { hintForCode, PostgresError, type PostgresErrorCode } from './errors.js';
export { DEFAULT_MAX_ROWS, HARD_MAX_ROWS, MAX_RESULT_BYTES } from './limits.js';
export type {
  MultiStatementEnvelope,
  ResultField,
  SqlResultEnvelope,
  TruncationReason,
} from './result-envelope.js';
export { fallsBackToPlaintext, sslOptionFor } from './ssl.js';

/**
 * Shortest password replaced by value in error text and in result rows.
 *
 * This is core's own documented floor (`DEFAULT_MIN_SECRET_LENGTH` in
 * `packages/kit/src/utils/secret-scrub.ts`), restated here rather than
 * lowered. It used to be 4, and 4 is well inside the range of a value that can
 * plausibly *be* data: a password of `2024` or `test` would have rewritten
 * every matching cell — and every matching **column name**, because the
 * scrubber redacts keys too — of the user's own `SELECT` to
 * `[REDACTED-SECRET]`. Core says it in as many words: "only pass a value that
 * cannot plausibly be legitimate data … replacing a placeholder token like
 * `Marketing` would corrupt every client name in the payload while leaving it
 * syntactically valid, which is worse than not scrubbing: the caller cannot
 * tell."
 *
 * The number is also passed to the `SecretScrubber` so the gate here and the
 * scrubber's own floor cannot disagree.
 *
 * The **full credential string** is registered regardless of this floor and is
 * the guarantee that survives every case: its shortest possible spelling
 * (`host=h dbname=d user=u`) is already well past eight characters, so
 * `SecretScrubber` never drops it. The `user:password` segment is *not* that
 * guarantee, which is what the comment here used to claim: the scrubber
 * discards any `secretValues` entry below `minSecretLength`, so for
 * `user=zz password=pw` the `zz:pw` segment goes too — precisely the short
 * password the warning fires on. Registering it is worth it for the ordinary
 * case and buys nothing in the short one.
 */
const MIN_SCRUBBED_SECRET_LENGTH = 8;

/**
 * Whether a password is distinctive enough to be replaced by value.
 *
 * Length alone is not the whole test. `password`, `baseball` and `aaaaaaaa` are
 * all eight characters and all of them are also ordinary text that can appear
 * in a result set — and `postgres`, the most common password there is on a
 * local instance, is exactly the value `SELECT datname FROM pg_database`
 * returns. Requiring two character classes is a cheap shape check that keeps
 * the single-word cases out while accepting anything a password policy would
 * ask for.
 *
 * A refusal is warned about rather than silent — but the warning states the
 * **rule**, never which half of it this password failed. It goes to the shared
 * host log, and in per-user mode the password is an end user's own: "shorter
 * than 8 characters" or "a single character class" narrows a brute force for
 * anyone who can read operator logs. The user needs to know their password is
 * not covered and what would cover it, which the rule says on its own.
 */
function canScrubByValue(password: string): boolean {
  if (password.length < MIN_SCRUBBED_SECRET_LENGTH) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-z\d]/i].filter((pattern) => pattern.test(password));
  return classes.length >= 2;
}

/** No `ROLLBACK` pairs with this: nothing to undo, and the connection closes anyway. */
const READ_ONLY_PREAMBLE = 'BEGIN READ ONLY';

/**
 * Stops `COMMIT; DELETE FROM t` escaping the preamble (`42601`). Explicit
 * because `pg` picks this protocol only when there are parameters.
 */
const EXTENDED_QUERY_MODE = 'extended';

export interface RunSqlOptions {
  sql: string;
  params?: readonly unknown[];
  maxRows?: number;
  readOnly?: boolean;
}

export class PostgresClient {
  readonly target: ConnectionTarget;
  private readonly scrubber: SecretScrubber;

  constructor(credential: string) {
    this.target = parseCredential(credential);
    // Registered by value, not by key name. Key-based redaction is deliberately
    // NOT configured: rows are the user's own data, and blanking every column
    // called "password" in their own SELECT would withhold the answer they
    // asked for. Value-based scrubbing still catches the credential if it ever
    // shows up in a row or in error text quoted back by PostgreSQL.
    const secrets = [credential, credential.trim()];
    const { password } = this.target;
    if (password !== undefined) {
      secrets.push(`${this.target.user}:${password}`);
      if (canScrubByValue(password)) {
        secrets.push(password);
      } else {
        // Not silent degradation: the password still authenticates, but it is
        // not distinctive enough to replace by value without mangling the
        // user's own rows and column names. The rule is named; which half of it
        // failed is not — see `canScrubByValue`.
        console.warn(
          '[Postgres] The configured password is not distinctive enough to be scrubbed by value: the rule is at least 8 characters and more than one character class, because an ordinary word or number can appear in your own data and replacing it everywhere would rewrite matching values — and column names — in your own query results. It is still used to connect, and the full connection string is still recognised wherever it appears; the password on its own is not, so one echoed verbatim by a PostgreSQL error would not be replaced. Use a longer, mixed-character password.',
        );
      }
    }
    // Deliberately NOT registered as a secret: the decoded `sslrootcert` is a
    // public certificate, and redacting it would blank a value the user may
    // legitimately want to read back. Its base64url blob is not registered
    // either — the guarantee that neither the blob nor the PEM shows up in a
    // message comes from the no-echo rule on `invalidCredential()`, which
    // covers the whole credential and needs no per-field exception.
    this.scrubber = new SecretScrubber({
      secretValues: secrets,
      minSecretLength: MIN_SCRUBBED_SECRET_LENGTH,
    });

    if (
      this.target.sslrootcert !== undefined &&
      this.target.sslmode !== 'verify-ca' &&
      this.target.sslmode !== 'verify-full'
    ) {
      // Behaviour is unchanged on purpose: a supplied CA must not silently
      // upgrade `require` (or a plaintext mode) into verification the user did
      // not ask for. Saying so is the whole remedy — a CA that is never
      // consulted looks exactly like one that is.
      console.warn(
        `[Postgres] The connection details carry an sslrootcert, but sslmode=${this.target.sslmode} does not verify the server certificate, so that CA is ignored. Nothing is changed for you: sslmode still means exactly what was asked for. Use sslmode=verify-full (or verify-ca) to have the certificate checked against it.`,
      );
    }
  }

  private scrub(text: string): string {
    return this.scrubber.scrubText(text);
  }

  /** `SELECT 1`, used by the connector host's "test connection" button. */
  async validateCredential(): Promise<void> {
    await withConnection(
      this.target,
      (text) => this.scrub(text),
      async (client) => {
        // Through `streamStatements` rather than `client.query('SELECT 1')`, so
        // there is exactly one way this package talks to the driver: one
        // accumulation contract and one client-side deadline. A second mechanism
        // is a second place for the `query_timeout` trap in `createClient` to
        // come back.
        await this.streamStatements(client, 'SELECT 1', undefined, {
          rows: 1,
          bytes: MAX_RESULT_BYTES,
        });
      },
    );
  }

  async runSql({
    sql,
    params,
    maxRows,
    readOnly = false,
  }: RunSqlOptions): Promise<SqlResultEnvelope | MultiStatementEnvelope> {
    // One budget for the whole call, deliberately not one per statement — see
    // `MAX_RESULT_BYTES`. `buildEnvelope` subtracts what each statement takes.
    const budget: ResultBudget = {
      rows: Math.min(maxRows ?? DEFAULT_MAX_ROWS, HARD_MAX_ROWS),
      bytes: MAX_RESULT_BYTES,
    };
    const rowLimit = budget.rows;
    return withConnection(
      this.target,
      (text) => this.scrub(text),
      async (client) => {
        if (readOnly) {
          // First, and on a budget of its own: the order is the enforcement, and
          // the preamble must not spend the caller's rows.
          await this.streamStatements(client, READ_ONLY_PREAMBLE, undefined, {
            rows: 1,
            bytes: MAX_RESULT_BYTES,
          });
        }
        const collected = await this.streamStatements(
          client,
          sql,
          params,
          budget,
          readOnly ? EXTENDED_QUERY_MODE : undefined,
        );
        // A multi-statement text query produces one result per statement.
        // Reporting only the first would quietly hide the rest.
        const statements = collected.map((statement) => buildEnvelope(statement, rowLimit));
        // `pg` only reports an array of results for a genuine multi-statement
        // text query (`_checkForMultirow` never builds a one-element array), so
        // the count is what tells a batch apart — not a flag this package sets.
        const single = statements[0];
        if (statements.length === 1 && single !== undefined) return single;
        return buildBatchEnvelope(statements);
      },
    );
  }

  /**
   * Runs the call's SQL and keeps only what the budget allows, **as the rows
   * arrive**.
   *
   * This is the whole memory bound, and it is why the driver is not driven
   * through `client.query(sql)` any more. That call returns a promise, and a
   * promise means `pg` has to hand over a finished result — so it materialises
   * every row of every statement in the connector process's heap first and the
   * budget could then only slice what was already there. For example,
   * `SELECT repeat('x',1000) FROM generate_series(1,5000000)` can consume
   * roughly 5 GB of heap and terminate the process instead of returning a
   * truncated answer.
   *
   * A `Query` submitted as a `Submittable` is the driver's own answer to that:
   * `Client.query()` neither wraps it in a promise nor assigns it a callback
   * (pg 8.23 `lib/client.js:677`), and `Query` only accumulates rows when
   * `this.callback || !this.listeners('row').length` (`lib/query.js:79`) — so
   * one `'row'` listener and no callback means `pg` parses each row, hands it
   * over, and keeps nothing. Everything past the budget is dropped here and
   * never referenced again.
   *
   * The peak is therefore the budget plus **one row being shaped**, and that
   * second term is not the row's wire size: `shapeRow` serialises, parses,
   * scrubs and serialises again, which for a 20 MB `bytea` measured ~480 MB —
   * ~24× the row, and a V8 out-of-memory abort of the whole host under a
   * 192 MB heap, for a row the budget was always going to refuse. `take()`
   * therefore refuses a row from the raw lengths of its `string` and `Buffer`
   * columns first (`rawRowFloor`), so the multiplier is never paid on a row
   * that cannot fit. What that floor cannot see is a `json`/`jsonb` column: it
   * arrives already parsed into objects and arrays, whose size cannot be read
   * off them cheaply, so one enormous JSON document is still shaped in full.
   * That is the residual exposure, and it is bounded by PostgreSQL's own 1 GB
   * field limit rather than by this package.
   *
   * What this does **not** do is stop the database. PostgreSQL still executes
   * the statement in full and still sends every row over the wire; refusing the
   * rest would mean either abandoning the connection mid-statement — which
   * would roll back an `UPDATE … RETURNING` the caller had already been told
   * about — or the extended protocol's portal limit, which `pg` answers
   * automatically on `portalSuspended` (`lib/query.js:189`) and so cannot be
   * held at one page. A `LIMIT` in the SQL is therefore still far cheaper than
   * the budget, and `truncation_note` says so to the model.
   *
   * `params` still forces the extended protocol (`requiresPreparation()`), so a
   * parameterised call remains one statement per query — PostgreSQL's rule, not
   * this package's.
   */
  private async streamStatements(
    client: pg.Client,
    sql: string,
    params: readonly unknown[] | undefined,
    budget: ResultBudget,
    queryMode?: typeof EXTENDED_QUERY_MODE,
  ): Promise<StatementRows[]> {
    // Keyed by the `Result` object `pg` reports the row against: a
    // multi-statement text query builds a fresh one per statement
    // (`_checkForMultirow`), so identity is what tells the statements apart —
    // and a statement that returns no rows never appears here at all, which is
    // why the ordered list comes from the 'end' payload instead.
    const byResult = new Map<object, StatementRows>();
    const seen: StatementRows[] = [];
    const collectorFor = (result: object): StatementRows => {
      const existing = byResult.get(result);
      if (existing !== undefined) return existing;
      const created: StatementRows = { result: result as pg.QueryResult, rows: [] };
      byResult.set(result, created);
      seen.push(created);
      return created;
    };
    // `@types/pg` marks the `'row'` event's second argument optional even
    // though `pg` always emits it (`lib/query.js:97`). Rows that arrive without
    // one are grouped here instead of being dropped: a row this package cannot
    // attribute is still a row the caller asked for, and `seen` makes sure it
    // reaches the result even though the 'end' payload will not mention it.
    const unattributed: object = {};

    // `queryMode` is missing from `@types/pg@8.23.1`.
    const config: pg.QueryConfig & { queryMode?: typeof EXTENDED_QUERY_MODE } = {
      text: sql,
      ...(params === undefined ? {} : { values: params as unknown[] }),
      ...(queryMode === undefined ? {} : { queryMode }),
    };
    const query = new pg.Query(config);
    query.on('row', (row: unknown, result?: object) => {
      take(collectorFor(result ?? unattributed), row, budget, this.scrubber);
    });

    return new Promise<StatementRows[]>((resolve, reject) => {
      let settled = false;
      // The client-side deadline, which `pg` would otherwise own — see the note
      // in `createClient` for why it cannot. The message is the one `pg` uses,
      // because `toPostgresError` recognises `QUERY_TIMEOUT` by that text when
      // no `57014` arrives (and none does when the server has gone silent).
      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Query read timeout'));
      }, STATEMENT_TIMEOUT_MS + CLIENT_DEADLINE_GRACE_MS);
      // `pg` can emit 'end' after an error on some paths, so the first
      // settlement wins. An 'error' listener is mandatory either way: an
      // unhandled 'error' on an EventEmitter throws out of `emit`, in a socket
      // callback, i.e. as an `uncaughtException`.
      query.on('error', (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(error);
      });
      query.on('end', (results: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        const list = Array.isArray(results) ? (results as object[]) : [results as object];
        const reported = list.map((result) => collectorFor(result));
        resolve([...reported, ...seen.filter((collector) => !reported.includes(collector))]);
      });
      client.query(query);
    });
  }
}
