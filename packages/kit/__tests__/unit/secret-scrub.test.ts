import { describe, expect, it } from 'vitest';
import { SecretScrubber } from '../../src/utils/secret-scrub.js';

/** A capability URL whose secret only the payload reveals — the Toggl `ical_url` shape. */
const ICAL_PATTERN = /\/ical\/workspace_user\/([A-Za-z0-9._~-]+)/g;

function togglLikeScrubber(secretValues: readonly string[] = []) {
  return new SecretScrubber({
    redactedKeyStems: ['api_token', 'intercom_hash', 'ical_url'],
    secretValues,
    capturePatterns: [ICAL_PATTERN],
  });
}

describe('SecretScrubber', () => {
  describe('with no configuration', () => {
    it('should leave a payload alone', () => {
      const payload = { api_token: 'still-here', nested: ['a', 1, null] };

      expect(new SecretScrubber().scrub(payload)).toEqual(payload);
    });
  });

  describe('redaction by key name', () => {
    it('should replace the value of a configured key', () => {
      const result = togglLikeScrubber().scrub({ id: 1, api_token: 'live-token-value' });

      expect(result).toEqual({ id: 1, api_token: '[REDACTED]' });
    });

    it('should match a stem as a substring, whatever its case', () => {
      // The same credential arrives under near-miss names, and each of them
      // carries the whole thing: `ical_urls` on a list, `ical_url_secret`,
      // `ICAL_URL` from a differently-cased proxy.
      const result = togglLikeScrubber().scrub({
        ICAL_URL: 'https://toggl.com/ical/x',
        ical_urls: ['one', 'two'],
        ical_url_secret: 'bare-secret-value',
      });

      expect(result).toEqual({
        ICAL_URL: '[REDACTED]',
        ical_urls: '[REDACTED]',
        ical_url_secret: '[REDACTED]',
      });
    });

    it('should keep a null under a redacted key', () => {
      // "The API returned no value" and "we withheld the value" are different
      // facts; reporting [REDACTED] here would claim a secret that is not there.
      expect(togglLikeScrubber().scrub({ api_token: null })).toEqual({ api_token: null });
    });

    it('should reach a redacted key nested in objects and arrays', () => {
      const result = togglLikeScrubber().scrub({
        data: [{ workspace: { id: 42, api_token: 'live-token-value' } }],
      });

      expect(result).toEqual({ data: [{ workspace: { id: 42, api_token: '[REDACTED]' } }] });
    });

    it('should not mutate the input', () => {
      const payload = { api_token: 'live-token-value' };

      togglLikeScrubber().scrub(payload);

      expect(payload.api_token).toBe('live-token-value');
    });
  });

  describe('redaction by known value', () => {
    // Generated to retain the 32-character token shape without embedding a credential-like literal.
    const TOKEN = 'a'.repeat(32);

    it('should replace a known secret embedded in free text', () => {
      const result = togglLikeScrubber([TOKEN]).scrub({
        description: `imported with token ${TOKEN} by hand`,
      });

      expect(result).toEqual({ description: 'imported with token [REDACTED-SECRET] by hand' });
    });

    it('should replace a known secret that appears as a key', () => {
      // A payload — or a proxy echoing one — can put the credential in the key.
      expect(togglLikeScrubber([TOKEN]).scrub({ [TOKEN]: 1 })).toEqual({
        '[REDACTED-SECRET]': 1,
      });
    });

    it('should ignore a configured value shorter than the floor', () => {
      // A stub value would otherwise mangle unrelated text while leaving the
      // payload syntactically valid, which the caller cannot detect.
      const scrubber = new SecretScrubber({ secretValues: ['abc'], minSecretLength: 8 });

      expect(scrubber.scrubText('abc is an ordinary word')).toBe('abc is an ordinary word');
    });

    it('should scrub a bare string, for the one path that has no payload', () => {
      // An upstream error body is handed back without being parsed.
      expect(togglLikeScrubber([TOKEN]).scrubText(`403 for ${TOKEN}`)).toBe(
        '403 for [REDACTED-SECRET]',
      );
    });
  });

  describe('redaction by shape', () => {
    it('should replace only the captured group, keeping the rest of the match', () => {
      const result = togglLikeScrubber().scrubText(
        'feed at https://toggl.com/ical/workspace_user/abcdefghijkl please',
      );

      expect(result).toBe('feed at https://toggl.com/ical/workspace_user/[REDACTED-SECRET] please');
    });

    it('should replace every occurrence in one string', () => {
      const result = togglLikeScrubber().scrubText(
        '/ical/workspace_user/aaaaaaaaaaaa and /ical/workspace_user/bbbbbbbbbbbb',
      );

      expect(result).toBe(
        '/ical/workspace_user/[REDACTED-SECRET] and /ical/workspace_user/[REDACTED-SECRET]',
      );
    });

    it('should scrub a secret found in one field wherever else it appears', () => {
      // A share link pasted into a description reveals a secret that then has
      // to be blanked out of the bare value in the next field over.
      const result = togglLikeScrubber().scrub({
        description: 'see /ical/workspace_user/sekrit-value-1234',
        note: 'the code is sekrit-value-1234',
      });

      expect(result).toEqual({
        description: 'see /ical/workspace_user/[REDACTED-SECRET]',
        note: 'the code is [REDACTED-SECRET]',
      });
    });

    it('should scrub the value of a redacted key wherever it appears bare', () => {
      const result = togglLikeScrubber().scrub({
        ical_url_secret: 'bare-secret-value',
        elsewhere: 'leaked bare-secret-value again',
      });

      expect(result).toEqual({
        ical_url_secret: '[REDACTED]',
        elsewhere: 'leaked [REDACTED-SECRET] again',
      });
    });

    it('should not treat a short capture as a secret worth chasing', () => {
      const result = togglLikeScrubber().scrub({
        description: 'see /ical/workspace_user/ab',
        note: 'ab',
      });

      // The link itself is still redacted; the two-character secret is not
      // hunted down in unrelated text.
      expect(result).toEqual({
        description: 'see /ical/workspace_user/[REDACTED-SECRET]',
        note: 'ab',
      });
    });

    it('should add the flags it needs to a pattern that lacks them', () => {
      const scrubber = new SecretScrubber({ capturePatterns: [/token=(\w+)/] });

      expect(scrubber.scrubText('token=aaa token=bbb')).toBe(
        'token=[REDACTED-SECRET] token=[REDACTED-SECRET]',
      );
    });

    it('should leave a match whose group did not participate', () => {
      const scrubber = new SecretScrubber({ capturePatterns: [/token(?:=(\w+))?/g] });

      expect(scrubber.scrubText('token alone')).toBe('token alone');
    });
  });

  /**
   * A key called `__proto__` is ordinary data somewhere, and the copy has to
   * keep it.
   *
   * Reached from the `postgres` package, whose rows are whatever the user's
   * own database holds — measured against PostgreSQL 17.11:
   * `SELECT 1 AS "__proto__", 2 AS ok` came back as `{"ok":2}` while `fields`
   * still announced the column, and
   * `jsonb_build_object('__proto__', jsonb_build_object('polluted', true))`
   * lost the nested object whole. `result[key] = value` on a plain `{}` is
   * why: `__proto__` is an accessor on `Object.prototype`, so the assignment
   * runs its setter instead of creating an own property.
   */
  describe('keys that collide with Object.prototype', () => {
    const scrubber = () => new SecretScrubber({ secretValues: ['long-enough-value'] });

    it('keeps a __proto__ key instead of silently losing it', () => {
      // `JSON.parse`, not a literal: an object literal's `__proto__` is a
      // prototype assignment, so a literal cannot even express this input —
      // which is exactly the shape `JSON.parse` produces and this class is fed.
      const scrubbed = scrubber().scrub(JSON.parse('{"__proto__": 1, "ok": 2}'));
      expect(JSON.parse(JSON.stringify(scrubbed))).toEqual(JSON.parse('{"__proto__": 1, "ok": 2}'));
      expect(Object.keys(scrubbed as object)).toEqual(['__proto__', 'ok']);
    });

    it('keeps a nested object under a __proto__ key, and still scrubs inside it', () => {
      const scrubbed = scrubber().scrub(
        JSON.parse('{"doc": {"__proto__": {"note": "long-enough-value"}}}'),
      );
      expect(JSON.stringify(scrubbed)).toBe('{"doc":{"__proto__":{"note":"[REDACTED-SECRET]"}}}');
    });

    it('pollutes nothing, whatever the key is called', () => {
      const scrubbed = scrubber().scrub(
        JSON.parse('{"__proto__": {"polluted": true}, "constructor": 3, "toString": 4}'),
      );
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(scrubbed as object)).toBe(Object.prototype);
      expect(JSON.stringify(scrubbed)).toBe(
        '{"__proto__":{"polluted":true},"constructor":3,"toString":4}',
      );
    });

    it('redacts a __proto__ key by name like any other', () => {
      const withStems = new SecretScrubber({ redactedKeyStems: ['__proto__'] });
      expect(JSON.stringify(withStems.scrub(JSON.parse('{"__proto__": "value"}')))).toBe(
        '{"__proto__":"[REDACTED]"}',
      );
    });
  });

  describe('pass-through', () => {
    it('should return primitives and null unchanged', () => {
      const scrubber = togglLikeScrubber(['a'.repeat(32)]);

      expect(scrubber.scrub(null)).toBeNull();
      expect(scrubber.scrub(42)).toBe(42);
      expect(scrubber.scrub(true)).toBe(true);
      expect(scrubber.scrub(undefined)).toBeUndefined();
    });

    it('should honour custom placeholders', () => {
      const scrubber = new SecretScrubber({
        redactedKeyStems: ['secret'],
        secretValues: ['long-enough-value'],
        redactedPlaceholder: '<gone>',
        secretPlaceholder: '<masked>',
      });

      expect(scrubber.scrub({ secret: 'x', note: 'long-enough-value' })).toEqual({
        secret: '<gone>',
        note: '<masked>',
      });
    });
  });
});
