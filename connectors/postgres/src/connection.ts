/**
 * Opening one connection, refusing a target the network policy forbids,
 * closing it bounded, and mapping whatever it threw onto this package.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateAddress } from '@dxheroes/mcp-kit';
import pg from 'pg';
import type { ConnectionTarget } from './credential.js';
import {
  CONNECTION_ERRNOS,
  errnoOf,
  hintForCode,
  PostgresError,
  pgErrorText,
  sqlstateOf,
} from './errors.js';
import { CONNECT_TIMEOUT_MS, HANGUP_TIMEOUT_MS, STATEMENT_TIMEOUT_MS } from './limits.js';
import { fallsBackToPlaintext, isSslUnsupported, sslOptionFor } from './ssl.js';
import { applyTypeParsers } from './type-parsers.js';

/**
 * Whether MCP targets may resolve to private-network addresses.
 *
 * Only the literal string `false` means blocked, so an unset or misspelled
 * value keeps today's behaviour (internal databases are the primary
 * self-hosted case) instead of silently hardening.
 *
 * Read per call, not once at import, so a test or a process that sets the
 * variable late sees the current value.
 */
function allowPrivateTargets(): boolean {
  return process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS !== 'false';
}

/**
 * Refuses a target the connector host's network policy does not allow.
 *
 * `safeFetch` cannot help here — it speaks HTTP, and this is a raw TCP
 * connection — so the same check is done by hand: resolve the host and test
 * *every* address it answers with, because a name with one public and one
 * private address must not slip through on the strength of the public one.
 *
 * `isPrivateAddress(ip, allowPrivate)` keeps reporting link-local (including
 * the cloud metadata endpoint 169.254.169.254) and unspecified addresses as
 * private even when `allowPrivate` is true, so those stay blocked under
 * either policy without a second list here to keep in sync.
 *
 * Nothing is memoised, and that is the point. `safeFetch` validates the host
 * on every request (`validateUrlHost` in `packages/kit/src/utils/ssrf.ts`),
 * and this package claims parity with it. Keeping a verdict for the life of a
 * client would not: a single early "allowed" could cover later connections to
 * a name whose DNS answer has since moved onto a private address. The price is one extra `getaddrinfo` per
 * tool call — `pg` resolves the name a second time regardless, and every call
 * opens a fresh connection anyway, so this doubles the DNS traffic of a call
 * that already pays for a TCP/TLS handshake: one more round trip, on a path
 * that is not latency-critical. (Not "the resolver caches it": glibc keeps no
 * cache of its own, and a minimal container without `nscd` or
 * `systemd-resolved` caches nothing.)
 */
async function assertTargetAllowed(
  target: ConnectionTarget,
  scrub: (text: string) => string,
): Promise<void> {
  const { host } = target;
  const allowPrivate = allowPrivateTargets();
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      const resolved = await lookup(host, { all: true, verbatim: true });
      addresses = resolved.map((entry) => entry.address);
    } catch (error) {
      throw new PostgresError(
        `Could not resolve database host "${host}": ${scrub(pgErrorText(error))}`,
        'CONNECTION_FAILED',
        hintForCode('CONNECTION_FAILED'),
      );
    }
    if (addresses.length === 0) {
      throw new PostgresError(
        `Database host "${host}" resolved to no addresses.`,
        'CONNECTION_FAILED',
        hintForCode('CONNECTION_FAILED'),
      );
    }
  }
  for (const address of addresses) {
    if (isPrivateAddress(address, allowPrivate)) {
      throw new PostgresError(
        `Database host "${host}" resolves to ${address}, which this connector host is not allowed to reach.`,
        'BLOCKED_TARGET',
        hintForCode('BLOCKED_TARGET'),
      );
    }
  }
}

/**
 * The generic connection hint, plus whatever the configured `sslmode` rules
 * in or out.
 *
 * It used to push `sslmode=require` at anyone on the default `prefer`,
 * because `prefer` connected in cleartext and a managed PostgreSQL that
 * insists on TLS refuses that with a plain connection error. `prefer` now
 * negotiates, so that advice would be wrong; what is worth saying instead is
 * which causes the mode has already excluded.
 */
function connectionFailedHint(target: ConnectionTarget): string {
  const base = hintForCode('CONNECTION_FAILED') ?? '';
  if (target.sslmode === 'disable') return base;
  if (fallsBackToPlaintext(target.sslmode)) {
    return `${base} TLS was attempted first and cleartext used only if the server reported no TLS support (sslmode=${target.sslmode}), and no certificate is verified in that mode — so neither a missing TLS nor an untrusted certificate explains this failure.`;
  }
  if (
    (target.sslmode === 'verify-ca' || target.sslmode === 'verify-full') &&
    target.sslrootcert === undefined
  ) {
    // The one dead end this used to leave the user in: a certificate from a
    // private or internal CA cannot be verified against the system trust
    // store, and the remedy is a field they have not been told about.
    return `${base} TLS is in use (sslmode=${target.sslmode}) and the certificate is verified against the system CA store only; one issued by a private or internal CA fails here until that CA is supplied as sslrootcert=<base64url-encoded PEM> in the stored connection details.`;
  }
  return `${base} TLS is in use (sslmode=${target.sslmode}); a certificate the connector host cannot verify also fails here.`;
}

/** Maps anything thrown by `pg` onto this package's codes, scrubbing as it goes. */
function toPostgresError(
  error: unknown,
  target: ConnectionTarget,
  scrub: (text: string) => string,
): PostgresError {
  if (error instanceof PostgresError) return error;

  const message = scrub(pgErrorText(error));
  const sqlstate = sqlstateOf(error);
  const errno = errnoOf(error);

  if (sqlstate === '28000' || sqlstate === '28P01') {
    return new PostgresError(message, 'AUTH_FAILED', hintForCode('AUTH_FAILED'), sqlstate);
  }
  if (sqlstate === '57014' || /query read timeout/i.test(message)) {
    return new PostgresError(
      message,
      'QUERY_TIMEOUT',
      hintForCode('QUERY_TIMEOUT'),
      sqlstate ?? undefined,
    );
  }
  if (isSslUnsupported(error)) {
    // The remedy is a single word, so it is worth naming instead of leaving
    // the caller with `pg`'s bare sentence — but only for a mode that does
    // not fall back. Under `prefer`/`allow` `withConnection` has already
    // retried in cleartext, so reaching here in one of those modes means
    // something else failed, and the old text then read "sslmode=prefer
    // requires it … use sslmode=prefer". Worse, the sentence used to be
    // matched inside server-supplied text: under `require` — which is
    // `rejectUnauthorized: false`, so any certificate completes the
    // handshake — an active MITM could author exactly this message and have
    // the connector host nudge the user towards a mode that accepts plaintext.
    const hint = fallsBackToPlaintext(target.sslmode)
      ? connectionFailedHint(target)
      : `This database is not configured for TLS at all, and sslmode=${target.sslmode} requires it. Have TLS enabled on the server, or — only on a network you trust end to end — use sslmode=prefer, which tries TLS and accepts cleartext when the server has none.`;
    return new PostgresError(message, 'CONNECTION_FAILED', hint);
  }
  if (
    (errno !== undefined && CONNECTION_ERRNOS.has(errno)) ||
    /timeout expired|connection terminated|timeout exceeded when trying to connect/i.test(message)
  ) {
    return new PostgresError(message, 'CONNECTION_FAILED', connectionFailedHint(target));
  }
  if (sqlstate !== undefined) {
    return new PostgresError(message, 'SQL_ERROR', hintForCode('SQL_ERROR'), sqlstate);
  }
  return new PostgresError(message, 'PG_ERROR', hintForCode('PG_ERROR'));
}

/**
 * Runs one statement (or a statement batch) on a connection of its own.
 *
 * Deliberately not pooled. A long-lived connector process can serve sporadic
 * calls for several credentials, so a pool would keep sockets open on a
 * database long after the last query. A connection per call costs one
 * handshake and owes nothing
 * afterwards, which is also why `McpServer.close()` needs no override.
 */
export async function withConnection<T>(
  target: ConnectionTarget,
  scrub: (text: string) => string,
  run: (client: pg.Client) => Promise<T>,
): Promise<T> {
  await assertTargetAllowed(target, scrub);
  const { sslmode, sslrootcert } = target;
  let client = createClient(target, sslOptionFor(sslmode, sslrootcert));
  try {
    try {
      await client.connect();
    } catch (error) {
      // libpq's `prefer`/`allow`: TLS was attempted and **`pg`** reported the
      // server answered the SSLRequest with 'N', so the connection is retried
      // in cleartext — the one outcome those two modes accept and the reason
      // they are not simply `ssl: false`. Any other failure (a TLS handshake
      // error, a refused connection, a rejected password) is the caller's to
      // see — and a *server* message that merely says the same sentence is
      // not this: see `isSslUnsupported`, which used to accept one and let a
      // hostile server downgrade a completed TLS session to cleartext.
      if (!fallsBackToPlaintext(sslmode) || !isSslUnsupported(error)) throw error;
      await hangUp(client);
      client = createClient(target, false);
      await client.connect();
    }
    return await run(client);
  } catch (error) {
    throw toPostgresError(error, target, scrub);
  } finally {
    // Unconditionally, including a client whose `connect()` rejected. It used
    // to be conditional on having connected, and a failed attempt therefore
    // kept its socket and its `pg.Client`: verified against a server that
    // sends a startup `FATAL` and holds the socket open, where ten failed
    // connects left ten sockets open. Real PostgreSQL closes it itself, so
    // this needs a hostile server or a broken pooler — but the connector
    // process would pay one leaked descriptor per tool call. `client` is the one
    // that was last connected to (the retry ends the first itself), and
    // ending a client that never connected is a documented no-op in `pg`
    // (8.23 `lib/client.js:785`).
    await hangUp(client);
  }
}

/**
 * Closes a client, bounded.
 *
 * `Client.end()` writes Terminate, half-closes the socket and resolves on the
 * stream's `'close'` — which a server that never closes its own side never
 * produces. Awaiting it unbounded would hang the tool call for ever (worse
 * than the leaked socket this replaced), so the wait is capped and the socket
 * destroyed if it outlives the cap. `pg` exposes no public way to do that,
 * hence the reach into `connection.stream`; a mock without one is simply left
 * alone by the optional chain.
 *
 * A failure to hang up must never replace the error that got us here.
 */
async function hangUp(client: pg.Client): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timedOut = await Promise.race([
      client.end().then(
        () => false,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), HANGUP_TIMEOUT_MS);
      }),
    ]);
    if (!timedOut) return;
    const stream = (client as unknown as { connection?: { stream?: { destroy?: () => void } } })
      .connection?.stream;
    stream?.destroy?.();
  } catch {
    // Swallowed, and the whole body is inside the guard rather than just the
    // `end()` rejection: this runs in a `finally`, so anything thrown here —
    // a synchronous throw out of `end()`, a `destroy()` that objects —
    // would replace the error that got us here.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One configured `pg.Client`, with the guards no client here may go without. */
function createClient(target: ConnectionTarget, ssl: pg.ClientConfig['ssl']): pg.Client {
  const { host, port, database, user, password } = target;
  const client = new pg.Client({
    host,
    port,
    database,
    user,
    ...(password === undefined ? {} : { password }),
    ssl,
    application_name: 'dxheroes-mcp-postgres',
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    // `query_timeout` is deliberately NOT set on the client, and this is not
    // a style choice — it silently breaks two things for a `Submittable`.
    // `Client.query()` reads `config.query_timeout || connectionParameters
    // .query_timeout` and, when either is set, **assigns `query.callback`**
    // as its own clear-the-timer wrapper (pg 8.23 `lib/client.js:733`). From
    // that one assignment:
    //   1. `Query#handleError` routes to `this.callback` and emits `'error'`
    //      only when there is none (`lib/query.js:128`), so nothing ever
    //      reaches the `'error'` listener in `streamStatements` — the promise
    //      stays pending for ever, the connection is never ended, and
    //      `SQL_ERROR` is unreachable for every server-side statement error.
    //      (pg's own timer calls the callback it captured *before* the
    //      reassignment, which is the no-op, so even the timeout is lost.)
    //   2. `Query#handleRowDescription` accumulates rows when
    //      `this.callback || !this.listeners('row').length`
    //      (`lib/query.js:79`), so the whole result set is buffered again and
    //      the memory bound is gone.
    // The client-side deadline lives in `streamStatements` instead, which is
    // the single path every statement in this package takes.
  });
  // `pg` emits 'error' on the Client when the socket dies mid-query — a
  // database restart, `pg_terminate_backend`, a NAT sending an RST. Both
  // `_handleErrorEvent` and the connection's 'end' path call
  // `this.emit('error', err)` without checking for a listener, and Node
  // throws an unhandled 'error' event out of `emit`. That throw happens in a
  // socket callback, i.e. outside every `try` and outside every promise: it
  // becomes an `uncaughtException`, which can terminate the connector process
  // and its other active calls. Absorbing it loses nothing: the awaited
  // `connect()`/`query()` rejects with the same failure and gets mapped by
  // `toPostgresError` as usual. Every client built here needs this, which is
  // why there is only one place that builds one.
  client.on('error', () => undefined);

  // `date`, `timestamp` and `numeric[]` go out as the text PostgreSQL sent —
  // see `RAW_TEXT_OIDS` and `RAW_TEXT_ELEMENT_ARRAY_OIDS` for what each
  // default got wrong, and `applyTypeParsers` for why this is per client.
  applyTypeParsers(client);
  return client;
}
