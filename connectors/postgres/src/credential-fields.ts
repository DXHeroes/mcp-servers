/**
 * One field of the credential at a time: the accepted spellings, the format
 * help every message quotes, and the parser for each individual field.
 */
import { hintForCode, PostgresError } from './errors.js';

const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'] as const;
export type SslMode = (typeof SSL_MODES)[number];

export const KEYWORD_KEYS = [
  'host',
  'port',
  'dbname',
  'user',
  'password',
  'sslmode',
  'sslrootcert',
] as const;

/**
 * base64url alphabet, padding optional.
 *
 * base64url and not standard base64, in both accepted forms so the field is
 * written the same way in each: `+` decodes to a space inside a URL query
 * string, and `/` invites escaping mistakes. A value carrying either is
 * rejected with a message naming base64url, because pasting standard base64 is
 * the likely mistake.
 */
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

/** One PEM certificate block. Several may be concatenated. */
const PEM_CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/;
/** A key in the CA slot is a mistake worth naming rather than forwarding to TLS. */
const PEM_PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

/**
 * The two accepted spellings of the credential, verbatim, for every message
 * that has to teach the format. One copy, so the UI hint and the error text
 * cannot drift apart.
 */
export const CREDENTIAL_FORMAT_HELP =
  'Expected either a URL — "postgresql://user:password@host:5432/dbname?sslmode=require" (postgres:// also works) — or the keyword form with fields separated by spaces or semicolons: "host=db.example.com port=5432 dbname=mydb user=myuser password=secret sslmode=require". Required: host, dbname, user. Defaults: port=5432 and sslmode=prefer, which attempts TLS and falls back to an unencrypted connection only if the server reports it has no TLS at all; it verifies no certificate, so use sslmode=require to insist on encryption and verify-full to also verify the server. Optional in both forms: sslrootcert=<one or more PEM CA certificates, base64url-encoded>, which sslmode=verify-ca and verify-full then verify against. In the URL form, sslmode and sslrootcert may be written in any case but not written twice, they must go after a "?" and not a "#", and a present-but-empty sslmode= is refused rather than read as the default. Any other query parameter starting with "ssl" is refused rather than ignored, except sslcompression=0, sslnegotiation=postgres and sslsni=1, which are accepted and ignored because they ask for what this package already does.';

function isSslMode(value: string): value is SslMode {
  return (SSL_MODES as readonly string[]).includes(value);
}

/**
 * Builds the `INVALID_CREDENTIAL` error, and carries the one rule every caller
 * of it has to obey: **`detail` must not contain a single character that came
 * out of the credential.**
 *
 * `parseCredential` runs in `PostgresClient`'s constructor, before the scrubber
 * exists, so there is nothing downstream that could clean a leak up: whatever
 * this message says travels to `console.warn`, to `initError.message` and from
 * there into the model's tool result and the debug log, and to the `validate()`
 * response. A message that quotes the token it choked on is a message that
 * publishes a password — the keyword form splits on whitespace, so half a
 * password with a space in it arrives as its own "field", and a foreign scheme
 * with an `=` in its query string arrives as one giant "key" with the whole
 * `user:password@host` inside it.
 *
 * Actionability comes from the *position* and the rule instead: the field index
 * (counted from 1, in the order the user wrote them) plus the accepted set is
 * enough to find the mistake without reprinting it.
 */
export function invalidCredential(detail: string): PostgresError {
  return new PostgresError(
    `${detail} ${CREDENTIAL_FORMAT_HELP}`,
    'INVALID_CREDENTIAL',
    hintForCode('INVALID_CREDENTIAL'),
  );
}

export function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    // The value is not quoted back: it is caller text, and a mistyped
    // credential can have anything in that slot, the password included.
    throw invalidCredential('The port is not a decimal number.');
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    // Not even the number: the rule on `invalidCredential()` has no exceptions,
    // and an all-digit password typed into the `port=` slot is the narrow case
    // that would otherwise slip through. The range says everything the value
    // would.
    throw invalidCredential('The port is outside the range 1-65535.');
  }
  return port;
}

export function parseSslMode(raw: string | undefined): SslMode {
  if (raw === undefined) return 'prefer';
  if (raw === '') {
    // Absent means `prefer`; present-but-empty means something went wrong
    // upstream of this credential — an unsubstituted `${SSLMODE}` in a Helm
    // value, a rendered CI secret whose variable was never set — and silently
    // reading it as the default is a TLS posture nobody chose. libpq refuses it
    // too: a present `sslmode` is validated against the accepted list, and
    // there is no "empty means default" rule for it (unlike `sslrootcert`,
    // where libpq does treat an empty value as unset, and so does this file).
    throw invalidCredential(
      `The sslmode field is present but empty. Remove it to accept the default (prefer), or give it one of: ${SSL_MODES.join(', ')}. An empty value is refused rather than defaulted, because it is usually a variable that was never substituted, and reading it as a default would quietly choose how the connection is encrypted.`,
    );
  }
  const mode = raw.toLowerCase();
  if (!isSslMode(mode)) {
    // Same rule as everywhere in this file: the accepted list is what makes the
    // message useful, and it needs none of the caller's text to say it.
    throw invalidCredential(`Unknown sslmode; accepted: ${SSL_MODES.join(', ')}.`);
  }
  return mode;
}

/**
 * Decodes the `sslrootcert` field — a base64url-encoded PEM CA certificate, or
 * several concatenated ones.
 *
 * Why encoded at all: the keyword form splits on whitespace, so a multi-line
 * PEM cannot be written there literally. base64url rather than standard base64
 * so the same spelling works in the URL form, where `+` would decode to a
 * space.
 *
 * Why a CA can travel in the credential: without one, `verify-ca`/`verify-full`
 * can only verify against the system trust store, so a database with a private
 * or internal CA was reachable only under `sslmode=require` — encrypted, but
 * unverified, i.e. no defence against an active MITM. The deployment-level
 * alternative is `NODE_EXTRA_CA_CERTS`, which needs an operator; that is the
 * wrong shape for per-user credentials, where the user configures the
 * connection.
 *
 * What is validated here is the **shape**: base64url in, one or more PEM
 * certificate blocks out. Whether the bytes are a usable X.509 chain is Node's
 * TLS to decide at connect time, and it says so far better than a partial
 * parser here would.
 *
 * Nothing about the value is quoted back — see `invalidCredential()`. This
 * field is the easiest one in the credential to paste a password into by
 * mistake, and the encoded blob must no more appear in a message than the
 * password beside it.
 */
export function parseSslRootCert(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!BASE64URL_RE.test(raw)) {
    throw invalidCredential(
      'The sslrootcert value is not base64url. Encode the PEM certificate(s) with the base64url alphabet ("-" and "_", padding optional); standard base64 is rejected because "+" decodes to a space in a URL query string. The value is not quoted back here, because a mistyped credential can have a password in that slot.',
    );
  }
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  if (PEM_PRIVATE_KEY_BLOCK.test(decoded)) {
    throw invalidCredential(
      'The sslrootcert value decodes to a private key. This field takes only the CA certificate(s) that sign the database server certificate — a public trust anchor, never a key.',
    );
  }
  if (!PEM_CERTIFICATE_BLOCK.test(decoded)) {
    throw invalidCredential(
      'The sslrootcert value does not decode to a PEM certificate: a "-----BEGIN CERTIFICATE-----" … "-----END CERTIFICATE-----" block is required, and several concatenated certificates are accepted.',
    );
  }
  return decoded;
}

/**
 * Percent-decodes one component of the URL form.
 *
 * A malformed escape is an error rather than a pass-through: silently keeping
 * "%zz" would send a password nobody typed.
 */
export function decodePart(raw: string, what: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw invalidCredential(`The ${what} in the URL contains a malformed percent-escape.`);
  }
}
