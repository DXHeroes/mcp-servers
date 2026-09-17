/**
 * Unit tests for MerkClient — error handling, empty bodies and host validation.
 *
 * Tests mock global.fetch to verify HTTP requests are constructed correctly.
 * Shared setup lives in `client.helpers.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MerkApiError, MerkClient } from '../src/client.js';
import { beginClientTest, endClientTest, mockFetch, mockResponse } from './client.helpers.js';

describe('MerkClient', () => {
  let client: MerkClient;

  beforeEach(() => {
    client = beginClientTest();
  });

  afterEach(endClientTest);

  describe('error handling', () => {
    it('should throw INVALID_API_KEY on 401', async () => {
      mockFetch.mockResolvedValue(mockResponse({ detail: 'Unauthorized' }, 401));
      try {
        await client.companyLookup({ regno: '123' });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(MerkApiError);
        expect((e as MerkApiError).code).toBe('INVALID_API_KEY');
        expect((e as MerkApiError).status).toBe(401);
      }
    });

    it('should throw FORBIDDEN, not INVALID_API_KEY, on 403', async () => {
      // Was INVALID_API_KEY. A 403 from a DRF service means authentication
      // already succeeded and a permission check then refused the request, so
      // reporting it as a bad token sends the caller to re-issue a token that
      // works. See `mapStatusToCode`.
      mockFetch.mockResolvedValue(mockResponse({ detail: 'Forbidden' }, 403));
      try {
        await client.companyLookup({ regno: '123' });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(MerkApiError);
        expect((e as MerkApiError).code).toBe('FORBIDDEN');
        expect((e as MerkApiError).status).toBe(403);
      }
    });

    it('should throw NOT_FOUND on 404', async () => {
      mockFetch.mockResolvedValue(mockResponse({ detail: 'Not found' }, 404));
      try {
        await client.companyLookup({ regno: '123' });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(MerkApiError);
        expect((e as MerkApiError).code).toBe('NOT_FOUND');
      }
    });

    it('should throw RATE_LIMITED on 429', async () => {
      mockFetch.mockResolvedValue(mockResponse({ detail: 'Too many requests' }, 429));
      try {
        await client.companyLookup({ regno: '123' });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(MerkApiError);
        expect((e as MerkApiError).code).toBe('RATE_LIMITED');
      }
    });

    it('should throw BAD_REQUEST on 400', async () => {
      mockFetch.mockResolvedValue(mockResponse({ detail: 'Bad request' }, 400));
      try {
        await client.companyLookup({ regno: '123' });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(MerkApiError);
        expect((e as MerkApiError).code).toBe('BAD_REQUEST');
      }
    });

    it('should throw API_ERROR on 500', async () => {
      mockFetch.mockResolvedValue(mockResponse({ detail: 'Server error' }, 500));
      try {
        await client.companyLookup({ regno: '123' });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(MerkApiError);
        expect((e as MerkApiError).code).toBe('API_ERROR');
      }
    });
  });

  describe('204 No Content handling', () => {
    it('should return undefined on 204 response', async () => {
      // Was `null`. An absent body and a body that literally *is* `null` are
      // different answers and the server has to tell them apart, so the client
      // no longer collapses them — see the empty-body block in `request()`.
      mockFetch.mockResolvedValue({
        ok: true,
        status: 204,
        statusText: 'No Content',
        json: () => Promise.reject(new Error('no body')),
        text: () => Promise.resolve(''),
      });
      const result = await client.companyLookup({ regno: '99999999' });
      expect(result).toBeUndefined();
    });
  });

  // ── Empty and unparseable bodies (the step that started this sweep) ──

  describe('success responses without a usable JSON body', () => {
    /** A success status whose body cannot be parsed, the way `fetch` reports it. */
    function bodylessResponse(status: number, body: string) {
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'OK',
        json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
        text: () => Promise.resolve(body),
      };
    }

    it('should return undefined for an empty body on 200, not throw a parse error', async () => {
      // The regression this test exists for: 204 was checked, 200 was not, and
      // every other path ended in `response.json()`. An empty 200 therefore
      // rejected with a SyntaxError and reached the model as
      // `{"error":"API_ERROR","message":"Unexpected end of JSON input"}` — a
      // request that had in fact succeeded, reported as a server failure.
      mockFetch.mockResolvedValue(bodylessResponse(200, ''));
      await expect(client.companyLookup({ regno: '12345678' })).resolves.toBeUndefined();
    });

    it('should return undefined for a whitespace-only body', async () => {
      mockFetch.mockResolvedValue(bodylessResponse(200, '\n  \n'));
      await expect(client.subscriptionInfo()).resolves.toBeUndefined();
    });

    it('should return undefined on 205, which also carries no body', async () => {
      mockFetch.mockResolvedValue(bodylessResponse(205, ''));
      await expect(client.subscriptionInfo()).resolves.toBeUndefined();
    });

    it('should pass a body that is literally null through as null', async () => {
      // The distinction the `undefined` sentinel buys: "Merk said null" is an
      // answer, "Merk said nothing" is not, and the server reports them
      // differently.
      mockFetch.mockResolvedValue(mockResponse(null));
      await expect(client.companyLookup({ regno: '12345678' })).resolves.toBeNull();
    });

    it('should raise a MerkApiError, not a SyntaxError, for a non-JSON body', async () => {
      mockFetch.mockResolvedValue(bodylessResponse(200, '<html>connector host timeout</html>'));
      try {
        await client.companyLookup({ regno: '12345678' });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(MerkApiError);
        expect((e as MerkApiError).code).toBe('API_ERROR');
        expect((e as MerkApiError).hint).toBeDefined();
      }
    });
  });

  // ── Error shape: the code is a field, not a prefix ──────────────────

  describe('MerkApiError shape', () => {
    it('should keep the code out of the message', () => {
      const error = new MerkApiError('boom', 400, 'BAD_REQUEST');
      expect(error.message).toBe('boom');
      expect(error.message).not.toContain('BAD_REQUEST');
      expect(error.code).toBe('BAD_REQUEST');
    });

    it('should carry the upstream detail verbatim as the message', async () => {
      // `request()` reads `errorBody.detail` — a regression worth pinning,
      // because the empty-body rework touches the same block.
      mockFetch.mockResolvedValue(mockResponse({ detail: 'regno is not valid' }, 400));
      try {
        await client.companyLookup({ regno: '123' });
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as MerkApiError).message).toBe('regno is not valid');
      }
    });

    it('should fall back to the status text when there is no detail key', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: () => Promise.resolve({ regno: ['This field is required.'] }),
        text: () => Promise.resolve('{}'),
      });
      try {
        await client.companyLookup({ regno: '123' });
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as MerkApiError).message).toBe('Bad Request');
      }
    });

    it('should attach a hint for the codes a caller can act on', async () => {
      mockFetch.mockResolvedValue(mockResponse({ detail: 'Forbidden' }, 403));
      try {
        await client.companyLookup({ regno: '123' });
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as MerkApiError).hint).toContain('merk_subscription_info');
      }
    });

    it('should leave the hint off a plain server error', async () => {
      mockFetch.mockResolvedValue(mockResponse({ detail: 'Server error' }, 500));
      try {
        await client.companyLookup({ regno: '123' });
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as MerkApiError).hint).toBeUndefined();
      }
    });
  });

  // ── Status → code mapping, one case per mapped status ───────────────

  describe('status to error code mapping', () => {
    const cases: Array<[number, string]> = [
      [400, 'BAD_REQUEST'],
      [401, 'INVALID_API_KEY'],
      [402, 'PAYMENT_REQUIRED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [429, 'RATE_LIMITED'],
      [500, 'API_ERROR'],
      [503, 'API_ERROR'],
    ];

    for (const [status, code] of cases) {
      it(`should map ${status} to ${code}`, async () => {
        mockFetch.mockResolvedValue(mockResponse({ detail: 'nope' }, status));
        try {
          await client.companyLookup({ regno: '123' });
          expect.fail('Should have thrown');
        } catch (e) {
          expect((e as MerkApiError).code).toBe(code);
        }
      });
    }

    it('should not report 401 and 403 as the same failure', async () => {
      // The point of the split. One means "this token is wrong", the other
      // means "this token is right and may not have this" — opposite remedies.
      const codes: string[] = [];
      for (const status of [401, 403]) {
        mockFetch.mockResolvedValue(mockResponse({ detail: 'nope' }, status));
        try {
          await client.companyLookup({ regno: '123' });
        } catch (e) {
          codes.push((e as MerkApiError).code);
        }
      }
      expect(codes).toEqual(['INVALID_API_KEY', 'FORBIDDEN']);
    });
  });

  describe('validateApiKey after the code split', () => {
    it('should still treat a 403 on /subscriptions/ as an unusable token', async () => {
      // 403 is not a token problem anywhere else, but /subscriptions/ is the
      // account's own plan — the least a working token should be able to read.
      mockFetch.mockResolvedValue(mockResponse({ detail: 'Forbidden' }, 403));
      await expect(client.validateApiKey()).resolves.toEqual({
        valid: false,
        error: 'Invalid API key',
      });
    });

    it('should not blame the token for a 402', async () => {
      mockFetch.mockResolvedValue(mockResponse({ detail: 'Payment required' }, 402));
      const result = await client.validateApiKey();
      expect(result.valid).toBe(false);
      expect(result.error).not.toBe('Invalid API key');
      expect(result.error).toContain('Payment required');
    });
  });

  // ── safeFetch host validation ───────────────────────────────────────

  describe('outbound host validation', () => {
    it('should allow a private-network base URL', async () => {
      // Deliberate: the connector host's own default (MCP_ALLOW_PRIVATE_NETWORK_TARGETS)
      // permits private targets, so `allowPrivate: true` is passed and an
      // internally reachable host keeps working.
      const c = new MerkClient('my-key', 'http://192.168.1.10:8000');
      mockFetch.mockResolvedValue(mockResponse({ plan: 'pro' }));
      await expect(c.subscriptionInfo()).resolves.toEqual({ plan: 'pro' });
    });

    it('should block the cloud metadata endpoint regardless', async () => {
      const c = new MerkClient('my-key', 'http://169.254.169.254');
      mockFetch.mockResolvedValue(mockResponse({}));
      await expect(c.subscriptionInfo()).rejects.toThrow(/blocked/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
