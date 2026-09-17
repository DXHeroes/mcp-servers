/**
 * The timeouts and the row/byte budgets one tool call is allowed to spend.
 */

/** How long to wait for the TCP/TLS handshake and the startup exchange. */
export const CONNECT_TIMEOUT_MS = 10_000;
/**
 * How long a graceful hang-up may take before the socket is destroyed instead.
 *
 * `Client.end()` resolves on the socket's `'close'`, so a server that holds its
 * side open leaves it pending; see `hangUp`.
 */
export const HANGUP_TIMEOUT_MS = 2_000;
/**
 * Statement budget, enforced on both ends: `statement_timeout` is a server-side
 * cap, and `streamStatements` keeps a client-side deadline of its own (it
 * releases the tool call if the server goes quiet). One without the other
 * leaves a way to hang.
 *
 * **Neither one cancels anything.** `statement_timeout` ships as a session GUC,
 * so the arbitrary SQL this tool exists to run can switch it off in the same
 * call (`SET statement_timeout = 0`); the client-side deadline only rejects a
 * promise, and no CancelRequest is ever sent, so PostgreSQL keeps executing
 * after the caller has been told `QUERY_TIMEOUT`. Together they bound how long
 * a *tool call* takes, which is what protects the connector host — they do not bound
 * the database, and no message here may claim they do.
 */
export const STATEMENT_TIMEOUT_MS = 30_000;
/**
 * How long past `statement_timeout` the client waits before giving up on its
 * own.
 *
 * The two used to be the same number, which made them race: the client's
 * deadline could fire first and replace PostgreSQL's own `57014` — a real
 * SQLSTATE with a real message — with a bare "Query read timeout". The grace
 * lets the server's answer win whenever the server is still talking, and leaves
 * the client deadline as what it is for: a server that has gone silent.
 */
export const CLIENT_DEADLINE_GRACE_MS = 2_000;

/** Rows returned when the caller does not ask for a limit. */
export const DEFAULT_MAX_ROWS = 200;
/**
 * Ceiling on `max_rows`. `schemas.ts` imports this rather than restating it, so
 * the number the schema rejects above and the number this file cuts at cannot
 * drift apart.
 */
export const HARD_MAX_ROWS = 1000;
/**
 * Byte budget for the serialised rows of **one tool call**, counted in UTF-8
 * bytes. A thousand wide rows can dwarf a context window long before they hit
 * the row cap, so the cheaper of the two limits wins and the envelope says
 * which one bit.
 *
 * Shared by every statement of the call, not handed out per statement. A user
 * pasting a `psql` script with 50 `SELECT`s into one call would otherwise get
 * 50 × this — ~12.8 MB straight into the model's context. The row cap is
 * shared the same way; `ResultBudget` is what
 * threads the one allowance through the batch, the statement that exhausts it
 * says so with `has_more`, and `MultiStatementEnvelope.batch_truncated` says
 * the batch itself was cut short.
 *
 * Both budgets are spent **as rows arrive**, not applied to a finished result
 * set — see `streamStatements`. That distinction is the difference between a
 * cap and a decoration: buffering one
 * `SELECT repeat('x',1000) FROM generate_series(1,5000000)` buffered into the
 * connector process's heap can terminate every active call in that process.
 *
 * What this number does **not** bound is the transient cost of shaping the one
 * row currently being measured — see the peak described on
 * `streamStatements`, and `rawRowFloor` for the part of it `take()` refuses to
 * pay.
 */
export const MAX_RESULT_BYTES = 256_000;
