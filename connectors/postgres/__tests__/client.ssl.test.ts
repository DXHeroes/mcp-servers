/**
 * `PostgresClient` — TLS: `sslOptionFor`, the `prefer`/`require` negotiation
 * `withConnection` builds out of one retry, and `sslrootcert`.
 *
 * Shared mocks, fixtures and hooks live in `./client.harness.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createDnsMock,
  createPgMock,
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

const { PostgresClient, fallsBackToPlaintext, parseCredential, sslOptionFor } = await loadClient();

setupHarness();

describe('sslOptionFor', () => {
  it('maps every accepted sslmode', () => {
    expect(sslOptionFor('disable')).toBe(false);
    // `prefer` and `allow` attempt TLS, which is what libpq's `prefer` means.
    // Mapping them to `ssl: false` meant the *documented default* never even
    // offered encryption to a database that would have accepted it.
    expect(sslOptionFor('allow')).toEqual({ rejectUnauthorized: false });
    expect(sslOptionFor('prefer')).toEqual({ rejectUnauthorized: false });
    expect(sslOptionFor('require')).toEqual({ rejectUnauthorized: false });
    expect(sslOptionFor('verify-full')).toEqual({ rejectUnauthorized: true });
  });

  it('lets only prefer and allow fall back to cleartext', () => {
    expect(fallsBackToPlaintext('prefer')).toBe(true);
    expect(fallsBackToPlaintext('allow')).toBe(true);
    for (const mode of ['disable', 'require', 'verify-ca', 'verify-full'] as const) {
      expect(fallsBackToPlaintext(mode), mode).toBe(false);
    }
  });

  it('verifies the chain but not the hostname for verify-ca', () => {
    const option = sslOptionFor('verify-ca') as {
      rejectUnauthorized: boolean;
      checkServerIdentity: () => undefined;
    };
    expect(option.rejectUnauthorized).toBe(true);
    // verify-ca must not become verify-full by accident: Node checks the
    // hostname by default, so the check has to be switched back off.
    expect(option.checkServerIdentity()).toBeUndefined();
  });

  it('passes the resolved ssl option to pg', async () => {
    await new PostgresClient(PUBLIC_URL).validateCredential();
    expect(pgState.configs[0]?.ssl).toEqual({ rejectUnauthorized: false });
  });
});

/**
 * libpq's `prefer`: attempt TLS, accept cleartext only if the server says it
 * has none. `pg` has no such mode, so `withConnection` builds it out of one
 * retry — and the trigger is the literal sentence `pg` emits when the server
 * answers the SSLRequest with 'N' (pg 8.23 `lib/connection.js:86`), because
 * there is no code on that error.
 */
describe('sslmode negotiation', () => {
  const SSL_UNSUPPORTED = 'The server does not support SSL connections';
  const DEFAULT_URL = 'postgresql://alice:pw1234@db.example.com/shop';

  it('offers TLS on the default sslmode=prefer', async () => {
    await new PostgresClient(DEFAULT_URL).validateCredential();
    expect(pgState.configs).toHaveLength(1);
    expect(pgState.configs[0]?.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('retries in cleartext when the server reports no TLS support', async () => {
    pgState.connect.mockRejectedValueOnce(new Error(SSL_UNSUPPORTED));
    await new PostgresClient(DEFAULT_URL).validateCredential();

    expect(pgState.configs).toHaveLength(2);
    expect(pgState.configs[0]?.ssl).toEqual({ rejectUnauthorized: false });
    expect(pgState.configs[1]?.ssl).toBe(false);
  });

  it('retries for allow as well', async () => {
    pgState.connect.mockRejectedValueOnce(new Error(SSL_UNSUPPORTED));
    await new PostgresClient(`${DEFAULT_URL}?sslmode=allow`).validateCredential();
    expect(pgState.configs).toHaveLength(2);
  });

  it('does not retry any other connection failure', async () => {
    pgState.connect.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    await expectRejectedWith(
      new PostgresClient(DEFAULT_URL).validateCredential(),
      'CONNECTION_FAILED',
    );
    // A refused connection is not "the server has no TLS", and a second
    // cleartext attempt would only hide the cause.
    expect(pgState.configs).toHaveLength(1);
  });

  it('never downgrades a mode that asked for TLS', async () => {
    for (const mode of ['require', 'verify-ca', 'verify-full'] as const) {
      pgState.configs.length = 0;
      pgState.connect.mockReset();
      pgState.connect.mockRejectedValue(new Error(SSL_UNSUPPORTED));
      const error = await rejectionOf(
        new PostgresClient(`${DEFAULT_URL}?sslmode=${mode}`).validateCredential(),
      );

      expect(pgState.configs, mode).toHaveLength(1);
      expect(error.code, mode).toBe('CONNECTION_FAILED');
      // `pg`'s bare sentence leaves the caller nowhere; the remedy is a word.
      expect(error.hint, mode).toContain('not configured for TLS at all');
      expect(error.hint, mode).toContain('sslmode=prefer');
    }
  });

  it('ends the TLS attempt before opening the cleartext one', async () => {
    pgState.connect.mockRejectedValueOnce(new Error(SSL_UNSUPPORTED));
    await new PostgresClient(DEFAULT_URL).validateCredential();
    // Once for the abandoned TLS client, once for the connection that ran the
    // query: a client left open would hold a socket for the life of the
    // instance.
    expect(pgState.end).toHaveBeenCalledTimes(2);
  });

  /**
   * A server `ErrorResponse` that merely *says* the sentence is not `pg`
   * reporting a refused SSLRequest, and the difference is a downgrade.
   *
   * `pgErrorText()` joins the server's `message`/`detail`/`hint`/`where`, and a
   * startup-phase error rejects `client.connect()`, so the substring match used
   * to accept a server's own text. Measured against a server that answers
   * `'S'`, **completes the TLS handshake** and then sends
   * `FATAL: The server does not support SSL connections`: under `prefer` the
   * host tore the working TLS session down and opened a cleartext one
   * (connections=2, tlsEstablished=1, cleartextStartups=1), which under
   * `password`/`md5` auth puts the password on the wire in the clear. An active
   * attacker could force that already by injecting `'N'`; this handed it to a
   * hostile server plus a passive eavesdropper.
   *
   * `pg` tells the two apart by shape: a server error is a `DatabaseError`
   * whose `name` is the protocol message type `'error'` and whose `severity`
   * is the `S` field, and it may carry no SQLSTATE at all (verified against a
   * server that omits the `C` field). A local failure is a plain `Error`.
   */
  const serverError = (message: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(message), { name: 'error', severity: 'FATAL', ...extra });

  it('does not retry in cleartext when the server itself sent that message', async () => {
    for (const [label, error] of [
      ['no SQLSTATE, as a server omitting the C field sends it', serverError(SSL_UNSUPPORTED)],
      ['with a SQLSTATE', serverError(SSL_UNSUPPORTED, { code: '08P01' })],
      // The joined text is `message — detail — hint — where`, so a substring
      // match let the sentence arrive in any of those fields.
      [
        'buried in detail, which the substring match also accepted',
        serverError('permission denied', { detail: `note: ${SSL_UNSUPPORTED}` }),
      ],
    ] as const) {
      pgState.configs.length = 0;
      pgState.connect.mockReset();
      pgState.connect.mockRejectedValue(error);

      await rejectionOf(new PostgresClient(DEFAULT_URL).validateCredential());

      expect(pgState.configs, label).toHaveLength(1);
      expect(pgState.configs[0]?.ssl, label).toEqual({ rejectUnauthorized: false });
    }
  });

  it('treats each of the three server-error signals as enough on its own', async () => {
    // `serverError()` above sets `name`, `severity` and a SQLSTATE together, so
    // it passes whichever arm of `isServerError` survives — and the structural
    // claim the fix rests on is precisely that `name === 'error'` alone covers
    // a server that sends neither `C` nor `S`. Each signal therefore gets its
    // own case, with the other two absent.
    for (const [label, error] of [
      [
        'name only, as a DatabaseError with no C and no S field',
        Object.assign(new Error(SSL_UNSUPPORTED), { name: 'error' }),
      ],
      ['severity only', Object.assign(new Error(SSL_UNSUPPORTED), { severity: 'FATAL' })],
      ['SQLSTATE only', Object.assign(new Error(SSL_UNSUPPORTED), { code: '08P01' })],
    ] as const) {
      pgState.configs.length = 0;
      pgState.connect.mockReset();
      pgState.connect.mockRejectedValue(error);

      await rejectionOf(new PostgresClient(DEFAULT_URL).validateCredential());

      // One connection, still TLS: the server said the sentence, so it is not
      // `pg` reporting a refused SSLRequest and there is nothing to fall back
      // from.
      expect(pgState.configs, label).toHaveLength(1);
      expect(pgState.configs[0]?.ssl, label).toEqual({ rejectUnauthorized: false });
    }
  });

  it("matches pg's sentence whole, not as a substring of a local error", async () => {
    // A plain `Error` — so `isServerError` says no on all three counts — whose
    // message merely *contains* the sentence. A pooler or a proxy wrapping the
    // driver's text is the realistic source. Under `.includes()` this triggered
    // the cleartext retry; under `===` it does not.
    for (const message of [
      `${SSL_UNSUPPORTED} (reported by the connection pooler)`,
      `pool: ${SSL_UNSUPPORTED}`,
      `${SSL_UNSUPPORTED}.`,
    ]) {
      pgState.configs.length = 0;
      pgState.connect.mockReset();
      pgState.connect.mockRejectedValue(new Error(message));

      await rejectionOf(new PostgresClient(DEFAULT_URL).validateCredential());

      expect(pgState.configs, message).toHaveLength(1);
      expect(pgState.configs[0]?.ssl, message).toEqual({ rejectUnauthorized: false });
    }
  });

  it('never hints at a plaintext-accepting mode on a message the server wrote', async () => {
    // `require` is `rejectUnauthorized: false`, so an active MITM completes the
    // handshake with any certificate and can author this text — and the hint
    // then nudged the user towards `sslmode=prefer`, which accepts cleartext.
    // The attacker wrote the advice.
    pgState.connect.mockRejectedValue(serverError(SSL_UNSUPPORTED, { code: '08P01' }));
    const error = await rejectionOf(
      new PostgresClient(`${DEFAULT_URL}?sslmode=require`).validateCredential(),
    );

    expect(error.hint ?? '').not.toContain('sslmode=prefer');
    expect(error.hint ?? '').not.toContain('accepts cleartext');
  });

  it('never contradicts itself about a mode that already fell back', async () => {
    // Reached when the cleartext retry fails too. The hint used to read
    // "sslmode=prefer requires it … use sslmode=prefer", because the branch
    // assumed it could only be reached by a mode that does not fall back.
    pgState.connect.mockRejectedValue(new Error(SSL_UNSUPPORTED));
    const error = await rejectionOf(new PostgresClient(DEFAULT_URL).validateCredential());

    expect(pgState.configs).toHaveLength(2);
    expect(error.hint ?? '').not.toContain('requires it');
    expect(error.hint ?? '').toContain('TLS was attempted first');
  });

  it('gives the cleartext retry the same type parsers and error listener', async () => {
    pgState.connect.mockRejectedValueOnce(new Error(SSL_UNSUPPORTED));
    await new PostgresClient(DEFAULT_URL).validateCredential();

    // The retry goes through the same `createClient`, which is the point of
    // there being only one place that builds one: a second client assembled by
    // hand would sooner or later miss the `'error'` listener that keeps an
    // unhandled socket error from exiting the connector host process, or the type
    // parsers that keep a `date` from shifting a day.
    expect(pgState.typeParsers).toHaveLength(2);
    expect(pgState.typeParsers[1]?.get(1082)).toBeDefined();
    expect(pgState.instances[1]?.listenerCount('error')).toBe(1);
  });
});

/**
 * A private or internal CA carried inside the credential itself, so a per-user
 * connection can be verified without an operator adding a deployment-level
 * `NODE_EXTRA_CA_CERTS` bundle per database.
 */
describe('sslrootcert', () => {
  /**
   * Obvious test fixtures, not certificates: the package validates the PEM
   * *shape* and hands the bytes to Node's TLS, which is what decides whether an
   * X.509 chain is usable. No key material, real or otherwise, is involved.
   */
  const FIXTURE_CA_1 = [
    '-----BEGIN CERTIFICATE-----',
    Buffer.from('dxheroes-mcp-postgres test fixture, not a real certificate (1)').toString(
      'base64',
    ),
    '-----END CERTIFICATE-----',
  ].join('\n');
  const FIXTURE_CA_2 = [
    '-----BEGIN CERTIFICATE-----',
    Buffer.from('dxheroes-mcp-postgres test fixture, not a real certificate (2)').toString(
      'base64',
    ),
    '-----END CERTIFICATE-----',
  ].join('\n');

  /** How a user prepares the field: base64url, padding left on. */
  const encode = (pem: string) => Buffer.from(pem, 'utf8').toString('base64url');

  const urlWith = (params: string) =>
    `postgresql://alice:pw1234@db.example.com:5432/shop?${params}`;
  const keywordWith = (extra: string) =>
    `host=db.example.com dbname=shop user=alice password=pw1234 ${extra}`;

  it('reads a base64url PEM from the URL form', () => {
    const target = parseCredential(
      urlWith(`sslmode=verify-full&sslrootcert=${encode(FIXTURE_CA_1)}`),
    );
    expect(target.sslrootcert).toBe(FIXTURE_CA_1);
    expect(target.sslmode).toBe('verify-full');
  });

  it('reads a base64url PEM from the keyword form', () => {
    const target = parseCredential(
      keywordWith(`sslmode=verify-ca sslrootcert=${encode(FIXTURE_CA_1)}`),
    );
    expect(target.sslrootcert).toBe(FIXTURE_CA_1);
  });

  it('accepts a bundle of several concatenated certificates', () => {
    const bundle = `${FIXTURE_CA_1}\n${FIXTURE_CA_2}\n`;
    const target = parseCredential(urlWith(`sslmode=verify-full&sslrootcert=${encode(bundle)}`));
    expect(target.sslrootcert).toBe(bundle);
    expect(target.sslrootcert?.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(2);
  });

  it('rejects content that does not decode to a PEM certificate, without echoing it', () => {
    const blob = encode('hunter2-is-not-a-certificate');
    const error = expectPostgresError(() =>
      parseCredential(urlWith(`sslmode=verify-full&sslrootcert=${blob}`)),
    );
    expect(error.code).toBe('INVALID_CREDENTIAL');
    expect(error.message).toContain('BEGIN CERTIFICATE');
    // The blob sits in the same string as the password, and this field is the
    // easiest one to paste a password into by mistake — so neither the encoded
    // nor the decoded form may appear.
    expect(error.message).not.toContain(blob);
    expect(error.message).not.toContain('hunter2');
  });

  it('rejects a value that is not base64url, without echoing it', () => {
    const error = expectPostgresError(() =>
      parseCredential(urlWith('sslmode=verify-full&sslrootcert=hunter2%21%21not-base64url')),
    );
    expect(error.code).toBe('INVALID_CREDENTIAL');
    // The specific sentence, not just the word: `CREDENTIAL_FORMAT_HELP` names
    // base64url too, so a looser assertion would pass without this branch.
    expect(error.message).toContain('is not base64url');
    expect(error.message).not.toContain('hunter2');
  });

  it('names base64url when standard base64 was pasted instead', () => {
    // The mistake the encoding exists to prevent: `+` in a query string
    // decodes to a space, and `/` invites escaping mistakes.
    const error = expectPostgresError(() =>
      parseCredential(keywordWith('sslmode=verify-full sslrootcert=ab+cd/ef==')),
    );
    expect(error.message).toContain('is not base64url');
    expect(error.message).not.toContain('ab+cd/ef');
  });

  it('refuses a private key in the CA slot, without echoing it', () => {
    // Deliberately invalid synthetic PEM used only to verify rejection.
    const key = '-----BEGIN PRIVATE KEY-----\ninvalid-test-material\n-----END PRIVATE KEY-----';
    const error = expectPostgresError(() =>
      parseCredential(urlWith(`sslmode=verify-full&sslrootcert=${encode(key)}`)),
    );
    expect(error.code).toBe('INVALID_CREDENTIAL');
    expect(error.message).toContain('private key');
    expect(error.message).not.toContain('hunter2');
  });

  it('verifies the chain against the supplied CA for verify-full, hostname included', () => {
    expect(sslOptionFor('verify-full', FIXTURE_CA_1)).toEqual({
      ca: FIXTURE_CA_1,
      rejectUnauthorized: true,
    });
  });

  it('verifies the chain against the supplied CA for verify-ca but still not the hostname', () => {
    const option = sslOptionFor('verify-ca', FIXTURE_CA_1) as {
      ca: string;
      rejectUnauthorized: boolean;
      checkServerIdentity: () => undefined;
    };
    expect(option.ca).toBe(FIXTURE_CA_1);
    expect(option.rejectUnauthorized).toBe(true);
    // Same rule as without a CA: verify-ca checks the chain, never the name.
    expect(option.checkServerIdentity()).toBeUndefined();
  });

  it('does not let a CA upgrade require into a verifying mode', () => {
    // `require` means "encrypt, do not verify" in libpq, and a supplied CA must
    // not silently change what the user asked for.
    expect(sslOptionFor('require', FIXTURE_CA_1)).toEqual({ rejectUnauthorized: false });
    // Same for the negotiating modes: they encrypt when they can, and they
    // never verify — a CA in the credential does not change that.
    expect(sslOptionFor('prefer', FIXTURE_CA_1)).toEqual({ rejectUnauthorized: false });
  });

  it('hands the CA to pg for a verifying mode', async () => {
    await new PostgresClient(
      urlWith(`sslmode=verify-full&sslrootcert=${encode(FIXTURE_CA_1)}`),
    ).validateCredential();
    expect(pgState.configs[0]?.ssl).toEqual({ ca: FIXTURE_CA_1, rejectUnauthorized: true });
  });

  it('warns that a CA is unused in a non-verifying mode instead of changing the mode', async () => {
    const client = new PostgresClient(
      urlWith(`sslmode=require&sslrootcert=${encode(FIXTURE_CA_1)}`),
    );
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('sslmode=require'));
    await client.validateCredential();
    expect(pgState.configs[0]?.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('points at sslrootcert when a verifying mode has no CA to verify against', async () => {
    pgState.connect.mockRejectedValue(
      Object.assign(new Error('unable to verify the first certificate'), {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      }),
    );
    const error = await rejectionOf(
      new PostgresClient(urlWith('sslmode=verify-full')).validateCredential(),
    );
    expect(error.code).toBe('CONNECTION_FAILED');
    expect(error.hint).toContain('sslrootcert=');
  });
});
