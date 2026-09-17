/**
 * `PostgresClient` — credential parsing: both accepted forms, what is rejected,
 * and the rule that a rejection message never quotes the credential.
 *
 * Shared mocks, fixtures and hooks live in `./client.harness.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createDnsMock,
  createPgMock,
  expectPostgresError,
  loadClient,
  PUBLIC_URL,
  setupHarness,
} from './client.harness.js';

vi.mock('pg', () => createPgMock());
vi.mock('node:dns/promises', () => createDnsMock());

const { CREDENTIAL_FORMAT_HELP, PostgresError, parseCredential } = await loadClient();

setupHarness();

describe('parseCredential — URL form', () => {
  it('accepts postgresql:// and postgres://', () => {
    for (const scheme of ['postgresql', 'postgres']) {
      const target = parseCredential(`${scheme}://alice:pw1234@db.example.com:6543/shop`);
      expect(target).toMatchObject({
        host: 'db.example.com',
        port: 6543,
        database: 'shop',
        user: 'alice',
        password: 'pw1234',
      });
    }
  });

  it('defaults the port to 5432 and sslmode to prefer', () => {
    const target = parseCredential('postgresql://alice:pw1234@db.example.com/shop');
    expect(target.port).toBe(5432);
    expect(target.sslmode).toBe('prefer');
  });

  it('reads sslmode from the query string', () => {
    expect(parseCredential(PUBLIC_URL).sslmode).toBe('require');
  });

  it('reads sslmode and sslrootcert whatever case they are written in', () => {
    // `url.searchParams.get('sslmode')` matches exact case, so `?SSLMODE=`
    // silently fell through to the `prefer` default: the user asked for TLS,
    // was refused nothing, and got cleartext.
    expect(
      parseCredential('postgresql://a:pw1234@db.example.com/shop?SSLMODE=require').sslmode,
    ).toBe('require');
    expect(
      parseCredential('postgresql://a:pw1234@db.example.com/shop?SslMode=disable').sslmode,
    ).toBe('disable');
  });

  it('refuses a repeated TLS parameter instead of letting the last one win', () => {
    // libpq's rule is last-wins and this followed it, silently:
    // `?sslmode=require&SSLMODE=disable` connected in cleartext with nothing
    // said. The keyword form already refuses a repeated key for the same
    // reason — the likeliest cause is a mistake, not a deliberate override,
    // and the losing spelling takes effect nowhere while looking like it did.
    for (const query of [
      'sslmode=disable&SSLMODE=require',
      'sslmode=require&sslmode=require',
      'SslRootCert=x&sslrootcert=y',
    ]) {
      const error = expectPostgresError(() =>
        parseCredential(`postgresql://a:pw1234@db.example.com/shop?${query}`),
      );
      expect(error.code, query).toBe('INVALID_CREDENTIAL');
      expect(error.message, query).toContain('already set');
      // Position, never the text: a credential can have a password in any slot.
      expect(error.message, query).toContain('parameter 2');
      expect(error.message, query).not.toContain('pw1234');
    }
  });

  it('accepts, and ignores, the inert ssl parameters a managed connection string carries', () => {
    // A blanket `ssl*` refusal is right for a parameter that changes the
    // answer and wrong for these: they appear verbatim in the strings managed
    // PostgreSQL consoles hand out, and at these values they ask for exactly
    // what this package already does. Rejecting them made the user edit a
    // string they legitimately pasted, for nothing.
    for (const inert of ['sslcompression=0', 'sslnegotiation=postgres', 'sslsni=1', 'SSLSNI=1']) {
      const target = parseCredential(
        `postgresql://a:pw1234@db.example.com/shop?sslmode=require&${inert}`,
      );
      expect(target.sslmode, inert).toBe('require');
    }
    // The keyword form takes them the same way, so a field means one thing in
    // both spellings.
    expect(
      parseCredential(
        'host=db.example.com dbname=shop user=alice sslcompression=0 sslsni=1 sslmode=require',
      ).sslmode,
    ).toBe('require');
  });

  it('reads an inert value with surrounding whitespace as the value it is', () => {
    // `searchParams` percent-decodes, so `?sslsni=%201` and `?sslsni=1+` both
    // arrive with a space attached — which is what a hand-edited or
    // template-rendered connection string leaves behind. Without the `.trim()`
    // in `isInertSslParam` the allowlist misses it and the parameter is refused
    // as an unknown `ssl*` one, sending the user after a TLS problem that is a
    // stray space. The value is still matched exactly otherwise: only
    // whitespace and case are forgiven.
    for (const written of [
      'sslsni=%201',
      'sslsni=1%20',
      'sslsni=1+',
      'sslnegotiation=%20POSTGRES',
    ]) {
      const target = parseCredential(
        `postgresql://a:pw1234@db.example.com/shop?sslmode=require&${written}`,
      );
      expect(target.sslmode, written).toBe('require');
    }
    // Trimming does not turn a value the package cannot honour into one it can.
    expect(
      expectPostgresError(() =>
        parseCredential('postgresql://a:pw1234@db.example.com/shop?sslsni=%200'),
      ).code,
    ).toBe('INVALID_CREDENTIAL');
    // An empty value is not an inert one either: `?sslsni=` is what an
    // unsubstituted template variable leaves, and reading it as the default
    // would be the same silent downgrade an empty `sslmode=` is refused for.
    for (const empty of ['sslsni=', 'sslcompression=', 'sslnegotiation=']) {
      expect(
        expectPostgresError(() =>
          parseCredential(`postgresql://a:pw1234@db.example.com/shop?${empty}`),
        ).code,
        empty,
      ).toBe('INVALID_CREDENTIAL');
    }
  });

  it('still refuses the values of those parameters it cannot honour', () => {
    // `sslcompression=1` asks for compression, `sslnegotiation=direct` for a
    // direct TLS handshake, `sslsni=0` for SNI to be suppressed — none of which
    // this package does, so ignoring them would be the silent downgrade the
    // family rule exists to prevent.
    for (const asked of ['sslcompression=1', 'sslnegotiation=direct', 'sslsni=0']) {
      const error = expectPostgresError(() =>
        parseCredential(`postgresql://a:pw1234@db.example.com/shop?${asked}`),
      );
      expect(error.code, asked).toBe('INVALID_CREDENTIAL');
    }
    expect(
      expectPostgresError(() =>
        parseCredential('host=db.example.com dbname=shop user=alice sslcompression=1'),
      ).code,
    ).toBe('INVALID_CREDENTIAL');
  });

  it('reports an inherited property name as an ordinary unknown field', () => {
    // The inert-`ssl*` allowlist is looked up with a key that came straight out
    // of the credential, so an object literal would answer for `constructor`
    // (a function) and `__proto__` (`Object.prototype`) and turn the lookup
    // into a `TypeError` thrown out of `parseCredential` — where the caller is
    // owed an `INVALID_CREDENTIAL` and nothing else. It is a `Map`.
    for (const field of ['constructor=1', '__proto__=1', 'toString=1']) {
      const error = expectPostgresError(() =>
        parseCredential(`host=db.example.com dbname=shop user=alice ${field}`),
      );
      expect(error, field).toBeInstanceOf(PostgresError);
      expect(error.code, field).toBe('INVALID_CREDENTIAL');
      expect(error.message, field).toContain('Unknown field at position 4');
    }
    // And in the URL form, where an inherited name that starts with `ssl` would
    // take the same path.
    expect(
      expectPostgresError(() =>
        parseCredential('postgresql://a:pw1234@db.example.com/shop?ssl__proto__=1'),
      ).code,
    ).toBe('INVALID_CREDENTIAL');
  });

  it('refuses a URL whose parameters were written after a "#"', () => {
    // `#` starts a fragment, which is not part of the query string, so every
    // parameter after one is dropped: this used to connect on the `prefer`
    // default and say nothing about the sslmode it was handed.
    const error = expectPostgresError(() =>
      parseCredential('postgresql://a:pw1234@db.example.com/shop#sslmode=require'),
    );
    expect(error.code).toBe('INVALID_CREDENTIAL');
    expect(error.message).toContain('"#"');
    // The remedy for the other way a `#` gets in there: inside a password.
    expect(error.message).toContain('%23');
    expect(error.message).not.toContain('pw1234');
  });

  it('refuses a TLS query parameter it does not understand instead of ignoring it', () => {
    // Parity with the keyword form, which rejects an unknown field "for
    // precisely this stated reason": a typo in the one parameter that decides
    // whether the wire is encrypted must not be silently discarded.
    for (const [label, query] of [
      ['a misspelling of sslmode', 'sslmod=require'],
      ['a misspelling of sslrootcert', 'sslrootcer=abcd'],
      ['a libpq TLS parameter this package does not implement', 'sslcert=/etc/ssl/client.crt'],
      ['an underscored spelling', 'ssl_mode=require'],
    ] as const) {
      const error = expectPostgresError(() =>
        parseCredential(`postgresql://a:pw1234@db.example.com/shop?${query}`),
      );
      expect(error.code, label).toBe('INVALID_CREDENTIAL');
      expect(error.message, label).toContain('Query parameter 1');
      expect(error.message, label).toContain('sslmode, sslrootcert');
      // The no-echo rule has no exceptions, here either.
      expect(error.message, label).not.toContain('pw1234');
    }
  });

  it('counts the offending query parameter from 1 and still ignores non-TLS extras', () => {
    const error = expectPostgresError(() =>
      parseCredential(
        'postgresql://a:pw1234@db.example.com/shop?application_name=x&connect_timeout=9&sslmod=require',
      ),
    );
    expect(error.message).toContain('Query parameter 3');
  });

  it('percent-decodes a password containing reserved characters', () => {
    const target = parseCredential('postgresql://alice:p%40ss%2Fword@db.example.com/shop');
    expect(target.password).toBe('p@ss/word');
  });

  it('ignores query parameters other than sslmode', () => {
    const target = parseCredential(
      'postgresql://alice:pw1234@db.example.com/shop?application_name=x&connect_timeout=9',
    );
    expect(target.sslmode).toBe('prefer');
    expect(target.database).toBe('shop');
  });

  it('treats an omitted password as absent rather than empty', () => {
    expect(parseCredential('postgresql://alice@db.example.com/shop').password).toBeUndefined();
  });

  it('strips the brackets from an IPv6 literal host', () => {
    // `URL.hostname` keeps them, and `[2001:db8::5]` is not an IP address to
    // `isIP` nor a name DNS can ever answer for, so the brackets have to go or
    // the URL form simply does not support IPv6.
    const target = parseCredential('postgresql://alice:pw1234@[2001:db8::5]:5432/shop');
    expect(target.host).toBe('2001:db8::5');
    expect(target.port).toBe(5432);
  });
});

describe('parseCredential — keyword form', () => {
  it('accepts space-separated fields', () => {
    const target = parseCredential(
      'host=db.example.com port=6543 dbname=shop user=alice password=pw1234 sslmode=verify-full',
    );
    expect(target).toEqual({
      host: 'db.example.com',
      port: 6543,
      database: 'shop',
      user: 'alice',
      password: 'pw1234',
      sslmode: 'verify-full',
    });
  });

  it('accepts semicolon-separated and mixed separators', () => {
    const semi = parseCredential('host=db.example.com;dbname=shop;user=alice;password=pw1234');
    const mixed = parseCredential('host=db.example.com; dbname=shop user=alice;password=pw1234');
    expect(semi).toEqual(mixed);
    expect(semi.port).toBe(5432);
    expect(semi.sslmode).toBe('prefer');
  });

  it('strips surrounding single quotes from a value', () => {
    const target = parseCredential(
      "host='db.example.com' dbname='shop' user='alice' password='pw1234'",
    );
    expect(target.host).toBe('db.example.com');
    expect(target.password).toBe('pw1234');
  });

  it('refuses a repeated key instead of letting the last one win', () => {
    // libpq's rule is last-wins, and this deliberately departs from it. Fields
    // split on whitespace **and** `;` with no quoting escape, so a value
    // containing either arrives as several fields — and the one that matters is
    // exactly the one a user would type: a password with a semicolon in it
    // silently *replaced the host*, with no error and no warning.
    const error = expectPostgresError(() =>
      parseCredential(
        'host=first.example.com dbname=shop user=alice password=ab;host=second.example.com',
      ),
    );
    expect(error.code).toBe('INVALID_CREDENTIAL');
    expect(error.message).toContain('Field 5');
    // The remedy names both separators, not just the space.
    expect(error.message).toContain('a space or a semicolon');
    expect(error.message).toContain('%3B');
  });

  it('refuses a deliberately repeated key too, and says how to write it', () => {
    const error = expectPostgresError(() =>
      parseCredential('host=first.example.com dbname=shop user=alice host=second.example.com'),
    );
    expect(error.code).toBe('INVALID_CREDENTIAL');
    expect(error.message).toContain('Field 4');
    // Neither the key nor the value is quoted back — the no-echo rule has no
    // exceptions, and a repeated field can be half a password.
    expect(error.message).not.toContain('second.example.com');
  });

  it('names both separators when a value has a space in it', () => {
    const error = expectPostgresError(() =>
      parseCredential('host=db.example.com dbname=shop user=alice password=my pass'),
    );
    expect(error.message).toContain('a space or a semicolon');
    expect(error.message).toContain('%3B');
  });

  it('accepts an uppercase key', () => {
    expect(parseCredential('HOST=db.example.com DBNAME=shop USER=alice').host).toBe(
      'db.example.com',
    );
  });
});

describe('parseCredential — rejections', () => {
  const cases: [string, string][] = [
    ['empty string', '   '],
    ['neither form', 'db.example.com:5432/shop'],
    ['wrong scheme', 'mysql://alice:pw1234@db.example.com/shop'],
    ['url without host', 'postgresql:///shop'],
    ['url without database', 'postgresql://alice:pw1234@db.example.com'],
    ['url without user', 'postgresql://db.example.com/shop'],
    ['url port zero', 'postgresql://alice:pw1234@db.example.com:0/shop'],
    ['url port too large', 'postgresql://alice:pw1234@db.example.com:70000/shop'],
    ['keyword port not a number', 'host=db.example.com dbname=shop user=alice port=abc'],
    ['keyword port too large', 'host=db.example.com dbname=shop user=alice port=70000'],
    ['keyword missing host', 'dbname=shop user=alice password=pw1234'],
    ['keyword missing dbname', 'host=db.example.com user=alice password=pw1234'],
    ['keyword missing user', 'host=db.example.com dbname=shop password=pw1234'],
    ['keyword token without =', 'host=db.example.com dbname=shop user=alice sslmode'],
    ['keyword token starting with =', '=db.example.com dbname=shop user=alice'],
    ['unknown keyword (typo)', 'host=db.example.com dbname=shop user=alice sslmod=require'],
    ['unknown sslmode', 'host=db.example.com dbname=shop user=alice sslmode=maybe'],
    ['unknown sslmode in url', 'postgresql://alice:pw1234@db.example.com/shop?sslmode=maybe'],
    ['malformed percent-escape', 'postgresql://alice:%zz@db.example.com/shop'],
    // Both of these reach a branch that used to quote the caller's text back:
    // a foreign scheme with an `=` in it routes into the keyword branch and
    // becomes one enormous "unknown field", and a value with a space leaves an
    // orphan token that is half the password.
    ['foreign scheme with a query string', 'mysql://root:pw1234@db.example.com/app?charset=utf8'],
    [
      'keyword value containing a space',
      'host=db.example.com dbname=shop user=alice password=hunter pw1234tail',
    ],
  ];

  for (const [label, credential] of cases) {
    it(`rejects ${label} with INVALID_CREDENTIAL and never quotes the password`, () => {
      const error = expectPostgresError(() => parseCredential(credential));
      expect(error.code).toBe('INVALID_CREDENTIAL');
      expect(error.message).toContain(CREDENTIAL_FORMAT_HELP);
      expect(error.message).not.toContain('pw1234');
      expect(error.hint).toBeTruthy();
    });
  }

  it('locates an unknown field by position so the cause is findable', () => {
    const error = expectPostgresError(() =>
      parseCredential('host=db.example.com dbname=shop user=alice sslmod=require'),
    );
    expect(error.message).toContain('position 4');
    expect(error.message).toContain('sslmode');
  });
});

/**
 * `parseCredential` runs in the constructor, *before* the scrubber exists, so
 * nothing here can be cleaned up after the fact: a message that quotes the
 * caller's text is a message that leaks it — to the model's tool result, to the
 * debug log, to `console.warn`, and to the validate response.
 */
describe('parseCredential — messages never quote the credential', () => {
  const leaky: [string, string, string][] = [
    [
      'a foreign scheme falling into the keyword branch',
      'mysql://root:hunter2@db.example.com/app?charset=utf8',
      'position 1',
    ],
    [
      'an orphan token left by a value with a space',
      'host=db.example.com dbname=shop user=svc password=hunter2 hunter2-tail',
      'Field 5',
    ],
    [
      'an unknown sslmode value',
      'host=db.example.com dbname=shop user=svc sslmode=hunter2',
      'accepted:',
    ],
    [
      'a port that is not a number',
      'host=db.example.com dbname=shop user=svc port=hunter2',
      'port',
    ],
  ];

  it('does not quote the port even when the value is all digits', () => {
    // The narrow path the rule still has to cover: an all-digit password typed
    // into the `port=` slot. The range is in the message; the value adds
    // nothing to it.
    const error = expectPostgresError(() =>
      parseCredential('host=db.example.com dbname=shop user=svc port=99999'),
    );
    expect(error.message).not.toContain('99999');
    expect(error.message).toContain('1-65535');
  });

  for (const [label, credential, expectedFragment] of leaky) {
    it(`reports ${label} without echoing any of it`, () => {
      const error = expectPostgresError(() => parseCredential(credential));
      expect(error.code).toBe('INVALID_CREDENTIAL');
      expect(error.message).not.toContain('hunter2');
      expect(error.message).not.toContain('mysql://');
      // Still actionable: the rule and the position, just not the content.
      expect(error.message).toContain(expectedFragment);
    });
  }
});
