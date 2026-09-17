/**
 * Unit tests for FakturoidClient — construction, auth and transport.
 *
 * Tests mock global.fetch to verify HTTP requests are constructed correctly.
 * Every API call requires TWO fetches: token exchange + actual request.
 * After the first call the token is cached, so subsequent calls need only ONE fetch.
 */

import { lookup } from 'node:dns/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakturoidApiError, FakturoidClient } from '../src/client.js';
import {
  BASE,
  createTestClient,
  expectedBasicAuth,
  mockCachedResponse,
  mockFetch,
  mockResponse,
  mockTokenAndResponse,
  restoreGlobals,
} from './client.helpers.js';

// The client goes through `safeFetch`, which DNS-resolves every target host
// before handing it to `fetch`. In a unit suite that is a real lookup for
// app.fakturoid.cz — slow at best, and under fake timers it hangs the test.
// Stubbing the resolver to a public address keeps the SSRF check passing
// instantly and keeps these tests about the HTTP call, which is what the
// mocked `fetch` below is asserting on.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

describe('FakturoidClient', () => {
  let client: FakturoidClient;

  beforeEach(() => {
    client = createTestClient();
  });

  afterEach(() => {
    restoreGlobals();
  });

  // ── Constructor ──────────────────────────────────────────────────────

  describe('constructor', () => {
    it('rejects API key with fewer than 3 colon-separated parts', () => {
      expect(() => new FakturoidClient('only:two')).toThrow('Invalid API key format');
      expect(() => new FakturoidClient('nodelimiter')).toThrow('Invalid API key format');
    });

    it('rejects empty slug, clientId, or clientSecret', () => {
      expect(() => new FakturoidClient(':id:secret')).toThrow('required');
      expect(() => new FakturoidClient('slug::secret')).toThrow('required');
      expect(() => new FakturoidClient('slug:id:')).toThrow('required');
    });

    it('accepts valid slug:clientId:clientSecret', () => {
      const c = new FakturoidClient('my-slug:my-id:my-secret');
      expect(c).toBeInstanceOf(FakturoidClient);
    });

    it('handles clientSecret containing colons', async () => {
      const c = new FakturoidClient('slug:id:secret:with:colons');
      expect(c).toBeInstanceOf(FakturoidClient);
      // Verify the secret is reassembled correctly by making a call
      mockTokenAndResponse({ name: 'test' });
      // Awaited: `safeFetch` validates the host before it calls `fetch`, so the
      // call is not recorded until this promise settles.
      await c.getAccount();
      const tokenCall = mockFetch.mock.calls[0];
      const authHeader = tokenCall?.[1].headers.Authorization;
      const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString();
      expect(decoded).toBe('id:secret:with:colons');
    });
  });

  // ── OAuth Token Exchange ─────────────────────────────────────────────

  describe('OAuth token exchange', () => {
    it('calls correct token URL with correct method and headers', async () => {
      mockTokenAndResponse({ name: 'Test Account' });
      await client.getAccount();

      const [tokenUrl, tokenInit] = mockFetch.mock.calls[0] ?? [];
      expect(tokenUrl).toBe(`${BASE}/oauth/token`);
      expect(tokenInit.method).toBe('POST');
      expect(tokenInit.headers.Authorization).toBe(expectedBasicAuth);
      expect(tokenInit.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(tokenInit.headers.Accept).toBe('application/json');
      expect(tokenInit.headers['User-Agent']).toBe('LocalMcpGateway (support@dxheroes.io)');
      expect(tokenInit.body).toBe('grant_type=client_credentials');
    });

    it('throws TOKEN_EXCHANGE_FAILED on non-OK token response', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Unauthorized', 401));

      await expect(client.getAccount()).rejects.toThrow(FakturoidApiError);
      try {
        mockFetch.mockResolvedValueOnce(mockResponse('Unauthorized', 401));
        await client.getAccount();
      } catch (e) {
        expect(e).toBeInstanceOf(FakturoidApiError);
        expect((e as FakturoidApiError).code).toBe('TOKEN_EXCHANGE_FAILED');
      }
    });
  });

  // ── Token Caching ────────────────────────────────────────────────────

  describe('token caching', () => {
    it('reuses token for second call within expiry window', async () => {
      mockTokenAndResponse({ name: 'Account' });
      await client.getAccount();
      expect(mockFetch).toHaveBeenCalledTimes(2); // token + API

      mockCachedResponse([{ id: 1 }]);
      await client.listUsers();
      expect(mockFetch).toHaveBeenCalledTimes(3); // only 1 more fetch (API only)
    });

    it('fetches new token after expiry', async () => {
      mockTokenAndResponse({ name: 'Account' });
      await client.getAccount();
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Advance past token expiry (7200s) minus the 60s buffer
      vi.advanceTimersByTime(7200 * 1000);

      mockTokenAndResponse([{ id: 1 }]);
      await client.listUsers();
      // 2 (first call) + 2 (new token + API) = 4
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });

  // ── API Request Headers ──────────────────────────────────────────────

  describe('API request headers', () => {
    it('includes Bearer token, Accept, and User-Agent', async () => {
      mockTokenAndResponse({ name: 'Account' });
      await client.getAccount();

      const [, apiInit] = mockFetch.mock.calls[1] ?? [];
      expect(apiInit.headers.Authorization).toBe('Bearer test-token');
      expect(apiInit.headers.Accept).toBe('application/json');
      expect(apiInit.headers['User-Agent']).toBe('LocalMcpGateway (support@dxheroes.io)');
    });

    it('adds Content-Type for POST requests with body', async () => {
      mockTokenAndResponse({ id: 1 });
      await client.createInvoice({ subject_id: 5 });

      const [, apiInit] = mockFetch.mock.calls[1] ?? [];
      expect(apiInit.headers['Content-Type']).toBe('application/json');
    });

    it('adds Content-Type for PATCH requests with body', async () => {
      mockTokenAndResponse({ id: 1 });
      await client.updateInvoice({ id: 1 }, { note: 'updated' });

      const [, apiInit] = mockFetch.mock.calls[1] ?? [];
      expect(apiInit.headers['Content-Type']).toBe('application/json');
    });

    it('does NOT add Content-Type for GET requests', async () => {
      mockTokenAndResponse({ name: 'Account' });
      await client.getAccount();

      const [, apiInit] = mockFetch.mock.calls[1] ?? [];
      expect(apiInit.headers['Content-Type']).toBeUndefined();
    });

    it('does NOT add Content-Type for DELETE requests', async () => {
      mockTokenAndResponse(undefined, 204);
      await client.deleteInvoice({ id: 1 });

      const [, apiInit] = mockFetch.mock.calls[1] ?? [];
      expect(apiInit.headers['Content-Type']).toBeUndefined();
    });
  });

  // ── safeFetch ─────────────────────────────────────────────────

  describe('safeFetch', () => {
    it('validates the host before issuing the request', async () => {
      mockTokenAndResponse({ name: 'Test Account' });
      await client.getAccount();
      // safeFetch DNS-resolves the target and checks every address against the
      // private ranges. Seeing the resolver called for the API host is what
      // proves the request went through it rather than through bare fetch.
      expect(vi.mocked(lookup)).toHaveBeenCalledWith('app.fakturoid.cz', { all: true });
    });

    it('follows redirects manually rather than letting fetch do it', async () => {
      mockTokenAndResponse({ name: 'Test Account' });
      await client.getAccount();
      for (const call of mockFetch.mock.calls) {
        expect(call[1].redirect).toBe('manual');
      }
    });

    it('does not leak its own options into the fetch init', async () => {
      mockTokenAndResponse({ name: 'Test Account' });
      await client.getAccount();
      const [, tokenInit] = mockFetch.mock.calls[0] ?? [];
      const [, apiInit] = mockFetch.mock.calls[1] ?? [];
      expect(tokenInit).not.toHaveProperty('allowPrivate');
      expect(apiInit).not.toHaveProperty('allowPrivate');
      // The request still carries what the API needs.
      expect(tokenInit.body).toBe('grant_type=client_credentials');
      expect(apiInit.headers.Authorization).toBe('Bearer test-token');
    });
  });
});
