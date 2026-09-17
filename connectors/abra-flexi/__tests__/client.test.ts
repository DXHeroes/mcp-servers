/**
 * Unit tests for FlexiClient.
 *
 * Scope is deliberately narrow: this suite covers annotations, empty-body
 * handling, coded errors, and `safeFetch`, plus enough of the request path to prove those
 * changes are reached. It is not an attempt to cover all 30 tools' worth of
 * client methods — those are thin wrappers over `request()`, which is covered.
 *
 * `global.fetch` is stubbed. `safeFetch` calls `fetch` internally after its own
 * host validation, so the stub sees exactly the request that would go out, and
 * a request `safeFetch` blocks never reaches the stub at all — which is how the
 * SSRF assertions below tell the two apart.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlexiApiError, FlexiClient, type FlexiErrorCode } from '../src/client.js';

const mockFetch = vi.fn();

/**
 * TEST-NET-3 (RFC 5737). An IP literal, so `safeFetch` skips DNS entirely —
 * the suite never touches the network or a resolver — and it is public, so the
 * private-address branch is not what lets these requests through.
 */
const HOST = 'https://203.0.113.10/c/demo';
const API_KEY = `${HOST}|admin:secret`;
const AUTH = `Basic ${Buffer.from('admin:secret').toString('base64')}`;

function mockResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  };
}

/** Body in the shape Flexi actually answers with. */
function winstrom(payload: Record<string, unknown>) {
  return JSON.stringify({ winstrom: { '@version': '1.0', ...payload } });
}

describe('FlexiClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // `MCP_ALLOW_PRIVATE_NETWORK_TARGETS` is read per request now, so a stub left
    // standing would decide the next test's SSRF verdict.
    vi.unstubAllEnvs();
  });

  // ── API key parsing ──────────────────────────────────────────────────

  describe('constructor', () => {
    it('should reject a key without the "|" separator', () => {
      expect(() => new FlexiClient('https://demo.flexibee.eu/c/demo')).toThrow(
        /Invalid API key format/,
      );
    });

    it('should reject a key whose credentials half has no colon', () => {
      expect(() => new FlexiClient(`${HOST}|adminsecret`)).toThrow(
        /Both server URL and credentials/,
      );
    });

    it('should reject a key with an empty server URL', () => {
      expect(() => new FlexiClient('|admin:secret')).toThrow(/Both server URL and credentials/);
    });

    it('should build a Basic auth header from the credentials half', async () => {
      const client = new FlexiClient(API_KEY);
      mockFetch.mockResolvedValue(mockResponse(winstrom({ adresar: [] })));
      await client.listContacts();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: AUTH, Accept: 'application/json' }),
        }),
      );
    });

    it('should strip a trailing slash from the base URL', async () => {
      const client = new FlexiClient(`${HOST}/|admin:secret`);
      mockFetch.mockResolvedValue(mockResponse(winstrom({ adresar: [] })));
      await client.listContacts();
      expect(mockFetch).toHaveBeenCalledWith(`${HOST}/adresar.json`, expect.any(Object));
    });
  });

  // ── request() happy path ─────────────────────────────────────────────

  describe('request', () => {
    let client: FlexiClient;

    beforeEach(() => {
      client = new FlexiClient(API_KEY);
    });

    it('should unwrap the winstrom envelope', async () => {
      mockFetch.mockResolvedValue(mockResponse(winstrom({ adresar: [{ id: '1' }] })));
      await expect(client.listContacts()).resolves.toEqual({
        '@version': '1.0',
        adresar: [{ id: '1' }],
      });
    });

    it('should pass through a body that has no winstrom envelope', async () => {
      mockFetch.mockResolvedValue(mockResponse(JSON.stringify({ plain: true })));
      await expect(client.listContacts()).resolves.toEqual({ plain: true });
    });

    it('should put the id in the path and the rest in the query string', async () => {
      mockFetch.mockResolvedValue(mockResponse(winstrom({})));
      await client.getRecord('faktura-vydana', 42);
      expect(mockFetch).toHaveBeenCalledWith(`${HOST}/faktura-vydana/42.json`, expect.any(Object));

      mockFetch.mockClear();
      await client.listRecords('adresar', { limit: 10, start: 5 });
      expect(mockFetch).toHaveBeenCalledWith(
        `${HOST}/adresar.json?limit=10&start=5`,
        expect.any(Object),
      );
    });

    it('should wrap a write body in the winstrom envelope keyed by evidence', async () => {
      mockFetch.mockResolvedValue(mockResponse(winstrom({ success: 'true' })));
      await client.createContact({ nazev: 'Acme' });
      const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({
        winstrom: { adresar: { nazev: 'Acme' } },
      });
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    // Both empty-body branches are live and both feed the server's `successPayload`
    // on the server. They are asserted here as client behaviour so the server
    // suite can rely on `undefined` actually arriving.
    it('should return undefined for a DELETE that succeeds', async () => {
      mockFetch.mockResolvedValue(mockResponse('', 200));
      await expect(client.deleteRecord('adresar', 1)).resolves.toBeUndefined();
    });

    it('should return undefined for a 200 with an empty body', async () => {
      mockFetch.mockResolvedValue(mockResponse('', 200));
      await expect(client.listContacts()).resolves.toBeUndefined();
    });
  });

  // ── Error codes and messages ─────────────────────────────────────────

  describe('FlexiApiError', () => {
    it('should not prefix the code onto the message', () => {
      const error = new FlexiApiError('boom', 400, 'BAD_REQUEST');
      // Regression guard: this used to be 'BAD_REQUEST: boom', which
      // the server then reported as {error: 'BAD_REQUEST', message:
      // 'BAD_REQUEST: boom'} — the code twice, in one payload.
      expect(error.message).toBe('boom');
      expect(error.message).not.toContain('BAD_REQUEST:');
      expect(error.code).toBe('BAD_REQUEST');
      expect(error.status).toBe(400);
    });

    it('should carry an optional hint', () => {
      expect(new FlexiApiError('boom', 400, 'BAD_REQUEST').hint).toBeUndefined();
      expect(new FlexiApiError('boom', 403, 'FORBIDDEN', 'do this').hint).toBe('do this');
    });
  });

  describe('status mapping', () => {
    let client: FlexiClient;

    beforeEach(() => {
      client = new FlexiClient(API_KEY);
    });

    async function codeFor(status: number): Promise<FlexiErrorCode> {
      mockFetch.mockResolvedValueOnce(mockResponse('upstream text', status));
      const error = await client.listContacts().catch((e) => e);
      expect(error).toBeInstanceOf(FlexiApiError);
      return (error as FlexiApiError).code;
    }

    // The statuses ABRA Flexi documents for its REST API: 400 invalid
    // request / failed PUT, 401 bad credentials, 402 write access not
    // licensed, 403 insufficient permissions or license limit, 404 evidence
    // or record not found, 405/406 method or format not allowed.
    it.each([
      [400, 'BAD_REQUEST'],
      [401, 'INVALID_API_KEY'],
      [402, 'PAYMENT_REQUIRED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [405, 'BAD_REQUEST'],
      [406, 'BAD_REQUEST'],
      [422, 'UNPROCESSABLE'],
      [429, 'RATE_LIMITED'],
      [500, 'API_ERROR'],
      [503, 'API_ERROR'],
    ])('should map %i to %s', async (status, expected) => {
      await expect(codeFor(status)).resolves.toBe(expected);
    });

    // These two used to share one code, which sent
    // callers to re-check a password that was never the problem. Flexi
    // documents 403 as "insufficient permissions / license limit".
    it('should give 401 and 403 different codes', async () => {
      expect(await codeFor(401)).toBe('INVALID_API_KEY');
      expect(await codeFor(403)).toBe('FORBIDDEN');
      expect(await codeFor(401)).not.toBe(await codeFor(403));
    });

    it('should hint at what 402 and 403 actually mean', async () => {
      for (const status of [401, 402, 403, 404]) {
        mockFetch.mockResolvedValueOnce(mockResponse('nope', status));
        const error = (await client.listContacts().catch((e) => e)) as FlexiApiError;
        expect(typeof error.hint, `status ${status}`).toBe('string');
      }
      mockFetch.mockResolvedValueOnce(mockResponse('nope', 500));
      const generic = (await client.listContacts().catch((e) => e)) as FlexiApiError;
      expect(generic.hint).toBeUndefined();
    });
  });

  describe('error messages', () => {
    let client: FlexiClient;

    beforeEach(() => {
      client = new FlexiClient(API_KEY);
    });

    it('should use winstrom.message rather than the whole JSON body', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(JSON.stringify({ winstrom: { message: 'Neznama evidence' } }), 404),
      );
      const error = (await client.listContacts().catch((e) => e)) as FlexiApiError;
      expect(error.message).toBe('Neznama evidence');
    });

    it('should fall back to the raw body when it is not a Flexi envelope', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('<html>connector host timeout</html>', 504));
      const error = (await client.listContacts().catch((e) => e)) as FlexiApiError;
      expect(error.message).toBe('<html>connector host timeout</html>');
    });

    it('should fall back to the status text when the body is empty', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('', 500));
      const error = (await client.listContacts().catch((e) => e)) as FlexiApiError;
      expect(error.message).toBe('Error');
    });
  });

  // ── safeFetch / SSRF ─────────────────────────────────────────────────

  describe('safeFetch', () => {
    it('should send the request through safeFetch, not bare fetch', async () => {
      const client = new FlexiClient(API_KEY);
      mockFetch.mockResolvedValue(mockResponse(winstrom({})));
      await client.listContacts();
      // `redirect: 'manual'` is safeFetch's fingerprint: it follows redirects
      // itself so it can revalidate every hop. A bare `fetch` would not set it.
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ redirect: 'manual' }),
      );
      // allowPrivate is consumed by safeFetch and must not leak into fetch.
      expect(mockFetch.mock.calls[0]?.[1]).not.toHaveProperty('allowPrivate');
    });

    // The whole point of the allowPrivate decision. ABRA Flexi is routinely
    // on-premise; had this package inherited safeFetch's allowPrivate: false
    // default, every such installation would have broken on upgrade.
    it.each([
      ['RFC 1918', 'https://10.0.0.5/c/demo'],
      ['RFC 1918 (192.168)', 'https://192.168.1.20/c/demo'],
      ['loopback tunnel', 'https://127.0.0.1:5434/c/demo'],
    ])('should still reach an on-premise server on a %s address', async (_label, base) => {
      const client = new FlexiClient(`${base}|admin:secret`);
      mockFetch.mockResolvedValue(mockResponse(winstrom({ adresar: [] })));
      await expect(client.listContacts()).resolves.toBeDefined();
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    // ...and the part allowPrivate does NOT relax, which is the reason the
    // swap was worth making. The base URL is parsed out of the operator's API
    // key (`https://server/c/company|user:pass`), so its request target is not
    // constant: whoever can set the key could
    // previously point it at the cloud metadata endpoint and the bare fetch
    // would have gone.
    it.each([
      ['cloud metadata', 'https://169.254.169.254/c/demo'],
      ['link-local', 'https://169.254.10.1/c/demo'],
      ['unspecified', 'https://0.0.0.0/c/demo'],
    ])('should block a %s target even with allowPrivate', async (_label, base) => {
      const client = new FlexiClient(`${base}|admin:secret`);
      await expect(client.listContacts()).rejects.toThrow(/Request blocked/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should block a redirect that lands on the metadata endpoint', async () => {
      const client = new FlexiClient(API_KEY);
      mockFetch.mockResolvedValueOnce(
        mockResponse('', 302, { location: 'http://169.254.169.254/latest/meta-data/' }),
      );
      await expect(client.listContacts()).rejects.toThrow(/Request blocked/);
      // The first hop went out; the second was stopped before it was issued.
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('should block a blocked target on validateApiKey and getAccountInfo too', async () => {
      const client = new FlexiClient('https://169.254.169.254/c/demo|admin:secret');
      // validateApiKey catches and reports rather than throwing.
      await expect(client.validateApiKey()).resolves.toEqual({
        valid: false,
        error: expect.stringContaining('Request blocked'),
      });
      await expect(client.getAccountInfo()).rejects.toThrow(/Request blocked/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    /**
     * 🔬 `allowPrivate` is the operator's decision, not this package's.
     *
     * The base URL here comes out of the API key, and because that key can be
     * a PER-USER credential — so on this one path the outbound host is chosen by
     * any user the connection is reachable by, an `end_user` included, rather
     * than by the org admin who owns the row. A deployment hardened with
     * `MCP_ALLOW_PRIVATE_NETWORK_TARGETS=false` has to reach that path too;
     * hardcoding `true` here left loopback, 10/8 and 192.168/16 open to it.
     *
     * The last two rows pin the established setting semantics: only the literal
     * string `false` hardens, so an unset or misspelled value keeps the default
     * that on-premise Flexi installations depend on.
     */
    describe('MCP_ALLOW_PRIVATE_NETWORK_TARGETS', () => {
      const PRIVATE_TARGETS = [
        ['loopback', 'https://127.0.0.1:5434/c/demo'],
        ['RFC 1918', 'https://10.0.0.7:8080/c/demo'],
        ['RFC 1918 (192.168)', 'https://192.168.1.20/c/demo'],
      ];

      it.each(PRIVATE_TARGETS)('blocks a %s target when set to false', async (_label, base) => {
        vi.stubEnv('MCP_ALLOW_PRIVATE_NETWORK_TARGETS', 'false');
        const client = new FlexiClient(`${base}|admin:secret`);

        await expect(client.listContacts()).rejects.toThrow(/Request blocked/);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      // The other two `safeFetch` call sites, which have their own request
      // rather than going through `request()`.
      it('blocks validateApiKey and getAccountInfo when set to false', async () => {
        vi.stubEnv('MCP_ALLOW_PRIVATE_NETWORK_TARGETS', 'false');
        const client = new FlexiClient('https://10.0.0.7:8080/c/demo|admin:secret');

        await expect(client.validateApiKey()).resolves.toEqual({
          valid: false,
          error: expect.stringContaining('Request blocked'),
        });
        await expect(client.getAccountInfo()).rejects.toThrow(/Request blocked/);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it.each([
        ['unset', undefined],
        ['true', 'true'],
        // Not the literal `false`, so it is not a hardening instruction — the
        // setting deliberately treats it as allowed.
        ['0', '0'],
        ['False', 'False'],
      ])('keeps an on-premise target reachable when %s', async (_label, value) => {
        vi.stubEnv('MCP_ALLOW_PRIVATE_NETWORK_TARGETS', value);
        const client = new FlexiClient('https://10.0.0.7:8080/c/demo|admin:secret');
        mockFetch.mockResolvedValue(mockResponse(winstrom({ adresar: [] })));

        await expect(client.listContacts()).resolves.toBeDefined();
        expect(mockFetch).toHaveBeenCalledOnce();
      });

      // The flag never relaxes THIS, and it must not start gating it either.
      it('still blocks the metadata endpoint when set to false', async () => {
        vi.stubEnv('MCP_ALLOW_PRIVATE_NETWORK_TARGETS', 'false');
        const client = new FlexiClient('https://169.254.169.254/c/demo|admin:secret');

        await expect(client.listContacts()).rejects.toThrow(/Request blocked/);
        expect(mockFetch).not.toHaveBeenCalled();
      });
    });
  });

  // ── validateApiKey ───────────────────────────────────────────────────

  describe('validateApiKey', () => {
    let client: FlexiClient;

    beforeEach(() => {
      client = new FlexiClient(API_KEY);
    });

    it('should hit the company root, not an evidence', async () => {
      mockFetch.mockResolvedValue(mockResponse(winstrom({})));
      await client.validateApiKey();
      expect(mockFetch).toHaveBeenCalledWith(`${HOST}.json`, expect.any(Object));
    });

    it('should report valid on a 200', async () => {
      mockFetch.mockResolvedValue(mockResponse(winstrom({})));
      await expect(client.validateApiKey()).resolves.toEqual({ valid: true });
    });

    // Splitting 401 and 403 in `mapStatusToCode` must not change the verdict
    // here: on the validation endpoint both still mean "these credentials
    // cannot be used". This is the path that has its own request and would
    // have been missed by anyone fixing only `mapStatusToCode`.
    it('should report invalid for both 401 and 403', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('', 401));
      await expect(client.validateApiKey()).resolves.toEqual({
        valid: false,
        error: 'Invalid credentials',
      });

      mockFetch.mockResolvedValueOnce(mockResponse('', 403));
      const forbidden = await client.validateApiKey();
      expect(forbidden.valid).toBe(false);
      // ...but it says which of the two it was, because the remedies differ.
      expect(forbidden.error).toContain('403');
    });

    it('should report other failures without calling them bad credentials', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('', 500));
      await expect(client.validateApiKey()).resolves.toEqual({
        valid: false,
        error: 'Server returned 500',
      });
    });

    it('should report a transport failure rather than throwing', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(client.validateApiKey()).resolves.toEqual({
        valid: false,
        error: 'Validation failed: ECONNREFUSED',
      });
    });
  });

  // ── getAccountInfo ───────────────────────────────────────────────────

  describe('getAccountInfo', () => {
    let client: FlexiClient;

    beforeEach(() => {
      client = new FlexiClient(API_KEY);
    });

    it('should unwrap the winstrom envelope', async () => {
      mockFetch.mockResolvedValue(mockResponse(winstrom({ company: 'Acme s.r.o.' })));
      await expect(client.getAccountInfo()).resolves.toEqual({
        '@version': '1.0',
        company: 'Acme s.r.o.',
      });
    });

    it('should report the Flexi message on failure, not just the status text', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(JSON.stringify({ winstrom: { message: 'Firma neexistuje' } }), 404),
      );
      const error = (await client.getAccountInfo().catch((e) => e)) as FlexiApiError;
      expect(error).toBeInstanceOf(FlexiApiError);
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('Firma neexistuje');
    });
  });
});
