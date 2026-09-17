/**
 * What each `sslmode` means to `pg`, and how a refused SSLRequest is told
 * apart from every other connection failure.
 */
import pg from 'pg';
import type { SslMode } from './credential-fields.js';
import { sqlstateOf } from './errors.js';

/**
 * `sslmode` values that attempt TLS and accept plaintext if the server says it
 * has no TLS at all — libpq's `prefer` and `allow`.
 *
 * `pg` has no negotiate-then-fall-back mode of its own, so `withConnection`
 * implements it: connect with TLS, and retry once without it when `pg` reports
 * the server answered the SSLRequest with 'N'. That is exactly the string it
 * uses (pg 8.23 `lib/connection.js:86`), which is why the match is on the
 * literal message rather than on a code — there is no code.
 *
 * `allow` differs from libpq in one way, deliberately: libpq tries **plaintext**
 * first and TLS only if the server refuses, while this tries TLS first. The
 * outcome set is identical (either mode ends up encrypted-but-unverified or
 * plaintext, whichever the server supports); only the preference differs, and
 * preferring encryption is the safer of the two. Detecting "the server refuses
 * unencrypted connections" would mean pattern-matching a `pg_hba.conf`
 * rejection, which is a worse trade than a documented preference.
 */
const NEGOTIATED_SSL_MODES: readonly SslMode[] = ['prefer', 'allow'];

/** Whether this mode may fall back to plaintext after a refused SSLRequest. */
export function fallsBackToPlaintext(mode: SslMode): boolean {
  return NEGOTIATED_SSL_MODES.includes(mode);
}

/** The one message `pg` produces when the server answers the SSLRequest with 'N'. */
const SSL_UNSUPPORTED_MESSAGE = 'The server does not support SSL connections';

/**
 * Whether the failure came from the **server**, as an `ErrorResponse`, rather
 * than from `pg` itself.
 *
 * This is the discriminator the cleartext fallback turns on, and it has to be
 * structural. `pg` builds a `DatabaseError` for every `ErrorResponse` and hands
 * it the protocol message type as its `name` (`pg-protocol`
 * `dist/messages.js:36`), so `name === 'error'` holds even for a server that
 * sends neither an SQLSTATE nor a severity — verified against a server that
 * omits the `C` field, where `code` is `undefined`. A failure raised inside
 * `pg` is a plain `Error`: `name` `'Error'`, no `severity`, no SQLSTATE.
 * `instanceof pg.DatabaseError` would be the obvious test and is deliberately
 * not used: `pg` is mocked in this package's unit suite, and a check that
 * depends on the mock re-exporting a class is a check that silently stops
 * checking.
 */
function isServerError(error: unknown): boolean {
  const shape = error as { name?: unknown; severity?: unknown } | null;
  return (
    sqlstateOf(error) !== undefined ||
    shape?.name === 'error' ||
    typeof shape?.severity === 'string'
  );
}

/**
 * Whether `pg` itself reported that the server refused the SSLRequest.
 *
 * Matched on the message because that error carries no code (pg 8.23
 * `lib/connection.js:86`) — but on the **whole** message, and only when the
 * error did not come from the server. Both halves are a fix, not tidying.
 *
 * `pgErrorText()` joins the server's own `message`/`detail`/`hint`/`where`, and
 * a startup-phase `ErrorResponse` rejects `client.connect()`. So a server that
 * answered `'S'`, **completed the TLS handshake** and then sent
 * `FATAL: The server does not support SSL connections` had this return true —
 * and under `sslmode=prefer` `withConnection` then tore down a working TLS
 * session and replaced it with a cleartext one, sending the password in the
 * clear under `password`/`md5` auth. Verified against such a server:
 * connections=2, tlsEstablished=1, cleartextStartups=1. An active attacker
 * could already force that by injecting `'N'`; this handed it to a hostile
 * server with only a passive eavesdropper. `substring` matching made it worse
 * still — the sentence only had to appear *somewhere* in the joined text.
 */
export function isSslUnsupported(error: unknown): boolean {
  return (
    error instanceof Error && !isServerError(error) && error.message === SSL_UNSUPPORTED_MESSAGE
  );
}

/**
 * `sslmode` translated into what `pg` understands, for the **first** connection
 * attempt.
 *
 * `prefer` and `allow` attempt TLS here and are retried in plaintext by
 * `withConnection` only if the server reports it has no TLS support — libpq's
 * own semantics, and the credential format advertises libpq spellings. They
 * used to map straight to `ssl: false`, so the documented default silently
 * connected in cleartext against every database that would happily have
 * encrypted the session. Like libpq's `prefer`, this verifies nothing (an
 * attacker who can answer the SSLRequest can force the plaintext fallback);
 * `require` and up are the modes that mean something against an active
 * attacker, and the `apiKeyHint` says so.
 *
 * `require` encrypts without verifying, which is what libpq's `require` means.
 *
 * `verify-ca` and `verify-full` differ in exactly one thing, and it is not the
 * chain: both check it. `verify-full` also requires the certificate to name the
 * host that was dialled, which is what Node's TLS does by default — so
 * `verify-ca` has to switch that check back off, or it would silently be the
 * stricter mode the user did not ask for.
 *
 * `ca` is the decoded PEM from the credential's `sslrootcert`, when there is
 * one: it *replaces* the system trust store for the two verifying modes, which
 * is the point — a private or internal CA cannot be added to that store from
 * here. Absent, those modes verify against the system store exactly as before.
 *
 * A CA does **not** upgrade a mode. `require` keeps meaning "encrypt, do not
 * verify" even with one supplied, because that is what the user asked for;
 * `PostgresClient`'s constructor warns that the CA is then unused rather than
 * quietly changing the answer.
 */
export function sslOptionFor(mode: SslMode, ca?: string): pg.ClientConfig['ssl'] {
  switch (mode) {
    case 'disable':
      return false;
    case 'allow':
    case 'prefer':
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-ca':
      return {
        ...(ca === undefined ? {} : { ca }),
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
      };
    case 'verify-full':
      return { ...(ca === undefined ? {} : { ca }), rejectUnauthorized: true };
  }
}
