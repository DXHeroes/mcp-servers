/**
 * The two accepted credential forms — the URL form and the libpq keyword
 * form — and the connection target they parse into.
 */
import {
  decodePart,
  invalidCredential,
  KEYWORD_KEYS,
  parsePort,
  parseSslMode,
  parseSslRootCert,
  type SslMode,
} from './credential-fields.js';

export interface ConnectionTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password?: string;
  readonly sslmode: SslMode;
  /**
   * The decoded PEM of the CA (or CA bundle) to verify the server certificate
   * against, when the credential carried one. A public trust anchor, not a
   * secret — but the base64url blob it arrived as shares a string with the
   * password, so neither is ever echoed. Only `verify-ca` and `verify-full`
   * use it.
   */
  readonly sslrootcert?: string;
}

/**
 * The TLS query parameters the URL form understands.
 *
 * Read **case-insensitively**, and every other `ssl*` parameter is rejected
 * rather than ignored. Both halves fix the same silent downgrade, and the
 * keyword form's `KEYWORD_KEYS` check already refused a typo here "for
 * precisely this stated reason": `url.searchParams.get('sslmode')` matches
 * exact case, so `?SSLMODE=require` and `?sslmod=require` both fell through to
 * the `prefer` default and the user was told nothing. A parameter whose name
 * starts with `ssl` is one the writer meant to be about transport security —
 * `sslcert`, `sslkey`, `sslcrl` and `sslcompression` among them, none of which
 * this package implements — so ignoring it is the one outcome that must not
 * happen. Non-TLS extras (`application_name`, `connect_timeout`, a
 * cloud provider's own) are still ignored.
 */
const URL_TLS_KEYS: readonly string[] = ['sslmode', 'sslrootcert'];

/**
 * `ssl*` fields this package does not implement, mapped to the values that ask
 * for what it already does — accepted and ignored, any other value refused.
 *
 * A blanket refusal of the `ssl*` family is right for a parameter that changes
 * the answer, and wrong for these three: they turn up verbatim in connection
 * strings that managed-PostgreSQL consoles hand out, and at these values they
 * are inert. `sslcompression=0` asks for no compression (this never asks for
 * any, and the protocol dropped it); `sslnegotiation=postgres` asks for the
 * SSLRequest handshake `pg` performs; `sslsni=1` asks for SNI, which Node's
 * TLS sends by default. Refusing them rejected a string the user legitimately
 * pasted and told them to edit it for no gain. The *other* values
 * (`sslcompression=1`, `sslnegotiation=direct`, `sslsni=0`) do ask for
 * something this package cannot do, so those stay refused — the point of the
 * family rule is that a TLS parameter is never silently ignored.
 *
 * A `Map`, not an object literal: the lookup key comes straight out of the
 * credential, and `{}['constructor']` is a function while `{}['__proto__']` is
 * `Object.prototype` — so `constructor=1` in the keyword form threw a
 * `TypeError` out of `parseCredential` instead of the `INVALID_CREDENTIAL` the
 * caller is owed. A `Map` has no inherited keys to hit.
 */
const INERT_SSL_PARAMS: ReadonlyMap<string, readonly string[]> = new Map([
  ['sslcompression', ['0']],
  ['sslnegotiation', ['postgres']],
  ['sslsni', ['1']],
]);

/** Whether this `ssl*` field asks for behaviour the package already has. */
function isInertSslParam(key: string, value: string): boolean {
  return INERT_SSL_PARAMS.get(key)?.includes(value.trim().toLowerCase()) === true;
}

/**
 * The value of a TLS parameter, matched case-insensitively as libpq does.
 *
 * A repeated one never reaches here — `assertTlsParamsUnderstood` refuses it,
 * so there is at most one to find.
 */
function tlsParam(url: URL, key: (typeof URL_TLS_KEYS)[number]): string | undefined {
  let found: string | undefined;
  for (const [name, value] of url.searchParams) {
    if (name.toLowerCase() === key) found = value;
  }
  return found;
}

function assertTlsParamsUnderstood(url: URL): void {
  let position = 0;
  const seen = new Set<string>();
  for (const [name, value] of url.searchParams) {
    position += 1;
    const lower = name.toLowerCase();
    if (!lower.startsWith('ssl')) continue;
    if (URL_TLS_KEYS.includes(lower)) {
      if (seen.has(lower)) {
        // libpq lets the last value win, and so did this — silently:
        // `?sslmode=require&SSLMODE=disable` connected in cleartext with
        // nothing said. It is refused here for the same reason the keyword form
        // refuses a repeated key: the likeliest cause of two spellings of the
        // one parameter that decides whether the wire is encrypted is a mistake,
        // not a deliberate override, and "the last one wins" is only safe where
        // a repetition can be assumed deliberate. Named by position, never
        // quoted.
        throw invalidCredential(
          `Query parameter ${position} of the URL sets a TLS parameter an earlier parameter already set (matched without regard to case). It is refused rather than resolved by last-one-wins, because two spellings of the parameter that decides how — or whether — the connection is encrypted are far more likely to be a mistake than a deliberate override, and the losing one would take effect nowhere while looking like it did. Remove all but the one you meant; query parameters are counted from 1 and the parameter is not quoted back here, because a credential can have a password in any slot.`,
        );
      }
      seen.add(lower);
      continue;
    }
    if (isInertSslParam(lower, value)) continue;
    // Named by position, not quoted — the rule on `invalidCredential()` has
    // no exceptions, and this message is reached before the scrubber exists.
    throw invalidCredential(
      `Query parameter ${position} of the URL starts with "ssl" but is not one this package understands; accepted: ${URL_TLS_KEYS.join(', ')} (either case), plus ${[
        ...INERT_SSL_PARAMS,
      ]
        .map(([key, values]) => `${key}=${values.join('/')}`)
        .join(
          ', ',
        )}, which are accepted and ignored because they ask for what this package already does. Anything else is refused rather than ignored, because ignoring a TLS parameter — a misspelling of sslmode, or libpq's sslcert/sslkey/sslcrl, which are not supported here — would connect without the protection that was asked for and say nothing. Query parameters are counted from 1; parameters unrelated to TLS are still ignored.`,
    );
  }
}

function parseUrlForm(raw: string): ConnectionTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidCredential('The credential starts like a URL but could not be parsed.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    // Quoting the scheme is safe where quoting anything else is not: a URL
    // scheme's grammar is `[a-z][a-z0-9+.-]*`, so it cannot carry a `:`, an `@`
    // or any other part of the credential. (This branch is also unreachable
    // through `parseCredential`, which only routes `postgres(ql)://` here — it
    // stays as a guard for a direct caller.)
    throw invalidCredential(`Unsupported scheme "${url.protocol}".`);
  }
  if (url.hash !== '') {
    // A `#` starts a fragment, which is not part of the query string at all, so
    // every parameter written after one is dropped — `postgresql://u:p@h/db#sslmode=require`
    // silently connected on the `prefer` default. The fragment is also where an
    // unescaped `#` in a password ends up, which is the other half of the
    // remedy. Nothing is quoted back: what follows the `#` can be any part of
    // the credential.
    throw invalidCredential(
      'The URL contains a "#", which starts a fragment. Connection parameters must follow a "?" — anything after a "#" is not part of the query string and is ignored entirely, so an sslmode written there would have no effect at all. Replace the "#" with "?" if it was meant to introduce the parameters, and percent-encode a literal "#" inside a password as %23.',
    );
  }
  // `URL.hostname` keeps the brackets of an IPv6 literal, and "[::1]" is
  // neither an address `isIP` recognises nor a name DNS can ever answer for —
  // so without stripping them the URL form supports no IPv6 address at all.
  const host = url.hostname.replace(/^\[(.+)\]$/, '$1');
  if (!host) throw invalidCredential('The URL has no host.');
  // `URL` does NOT decode `username`, `password` or `pathname` — only the query
  // string gets that treatment. Decoding them here is what lets a password
  // containing "@" or "/" survive the URL form at all: percent-encoding is the
  // only way to write one, and handing "%40" to `pg` verbatim would fail
  // authentication with a message about the password being wrong.
  const database = decodePart(url.pathname.replace(/^\//, ''), 'database name');
  if (!database) throw invalidCredential('The URL has no database name (the path after the host).');
  const user = decodePart(url.username, 'user');
  if (!user) throw invalidCredential('The URL has no user.');
  const password = decodePart(url.password, 'password');
  const port = url.port === '' ? 5432 : parsePort(url.port);
  // Only `sslmode` and `sslrootcert` are honoured; other query parameters are
  // ignored rather than rejected, so a copied-in connection string with an
  // extra parameter still works — except for the TLS family, which is where
  // being ignored is a silent downgrade. See `assertTlsParamsUnderstood`.
  assertTlsParamsUnderstood(url);
  const sslmode = parseSslMode(tlsParam(url, 'sslmode'));
  // `searchParams` percent-decodes, so a standard-base64 blob pasted here
  // arrives with its `+` already turned into a space — which the base64url
  // check then reports as exactly that mistake.
  const sslrootcert = parseSslRootCert(tlsParam(url, 'sslrootcert'));
  return {
    host,
    port,
    database,
    user,
    ...(password === '' ? {} : { password }),
    sslmode,
    ...(sslrootcert === undefined ? {} : { sslrootcert }),
  };
}

function parseKeywordForm(raw: string): ConnectionTarget {
  const fields = new Map<string, string>();
  let position = 0;
  for (const token of raw.split(/[\s;]+/)) {
    if (token === '') continue;
    position += 1;
    const eq = token.indexOf('=');
    if (eq <= 0) {
      // The likeliest cause is a value containing a space: fields are split on
      // whitespace, so "password=my pass" arrives here as the orphan "pass" —
      // which is why the token itself is named by position and never quoted.
      throw invalidCredential(
        `Field ${position} is not of the form key=value (fields are counted from 1 and separated by spaces or semicolons; the field itself is not quoted back here, because it can be part of a password). A value containing a space or a semicolon cannot be written in the keyword form — use the URL form and percent-encode it (%20 for a space, %3B for a semicolon).`,
      );
    }
    const key = token.slice(0, eq).toLowerCase();
    const value = token.slice(eq + 1).replace(/^'(.*)'$/, '$1');
    // Accepted and ignored, in both forms so a field means the same in each —
    // see `INERT_SSL_PARAMS`. Not stored, so a repetition of one is not a
    // repeated key either.
    if (isInertSslParam(key, value)) continue;
    if (!(KEYWORD_KEYS as readonly string[]).includes(key)) {
      // Rejected rather than ignored on purpose: a typo such as
      // "sslmod=require" would otherwise connect in plaintext and say nothing.
      // Named by position for the same reason as above: a credential that is
      // not in the keyword form at all (a `mysql://user:password@host?a=b` URL,
      // say) lands here as one field whose "key" is most of the credential.
      throw invalidCredential(
        `Unknown field at position ${position}; accepted fields: ${KEYWORD_KEYS.join(', ')}.`,
      );
    }
    if (fields.has(key)) {
      // libpq lets the last value win. Here it is an error, because the
      // likeliest cause is not a deliberate repetition: fields split on
      // whitespace *and* `;` with no quoting escape, so a value containing
      // either arrives as several fields — `password=ab;host=evil.example.com`
      // parses as a password of `ab` and a *replaced* host, with nothing said.
      // Named by position, never quoted: the rule on `invalidCredential()` has
      // no exceptions, and the repeated field can be half a password.
      throw invalidCredential(
        `Field ${position} sets a key an earlier field already set. A value cannot contain a space or a semicolon — both separate fields here — so a value containing one arrives as several fields and would silently replace another key, the host included. Use the URL form and percent-encode the value (%20 for a space, %3B for a semicolon). If the repetition was deliberate, remove all but the one you meant; fields are counted from 1 and the field itself is not quoted back here, because it can be part of a password.`,
      );
    }
    fields.set(key, value);
  }

  const host = fields.get('host');
  const database = fields.get('dbname');
  const user = fields.get('user');
  const missing = [host ? null : 'host', database ? null : 'dbname', user ? null : 'user'].filter(
    (name): name is string => name !== null,
  );
  if (missing.length > 0 || !host || !database || !user) {
    throw invalidCredential(`Missing required field(s): ${missing.join(', ')}.`);
  }
  const portRaw = fields.get('port');
  const password = fields.get('password');
  const sslrootcert = parseSslRootCert(fields.get('sslrootcert'));
  return {
    host,
    port: portRaw === undefined || portRaw === '' ? 5432 : parsePort(portRaw),
    database,
    user,
    ...(password === undefined || password === '' ? {} : { password }),
    sslmode: parseSslMode(fields.get('sslmode')),
    ...(sslrootcert === undefined ? {} : { sslrootcert }),
  };
}

/**
 * Turns the one opaque credential string the connector host stores into a connection
 * target.
 *
 * A package gets a single secret, so the whole target has to travel inside it —
 * which is also why the host is part of the credential, and why a per-user
 * install lets each user choose their own database server.
 *
 * Throws `PostgresError('INVALID_CREDENTIAL')`. The message explains both
 * accepted forms and quotes **no** part of the credential — see
 * `invalidCredential()` for why that rule has no exceptions here.
 */
export function parseCredential(credential: string): ConnectionTarget {
  const raw = credential.trim();
  if (raw === '') throw invalidCredential('The connection details are empty.');
  if (/^postgres(ql)?:\/\//i.test(raw)) return parseUrlForm(raw);
  if (raw.includes('=')) return parseKeywordForm(raw);
  throw invalidCredential('The connection details match neither accepted form.');
}
