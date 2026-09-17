/**
 * Unit tests for FakturoidClient — error mapping, error message shape and
 * validateApiKey.
 *
 * Tests mock global.fetch to verify HTTP requests are constructed correctly.
 * Every API call requires TWO fetches: token exchange + actual request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakturoidApiError, FakturoidClient } from '../src/client.js';
import {
  createTestClient,
  mockFetch,
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

  // ── Error Handling ───────────────────────────────────────────────────

  describe('error handling', () => {
    it('throws INVALID_API_KEY on 401', async () => {
      mockTokenAndResponse('Unauthorized', 401);
      try {
        await client.getAccount();
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(FakturoidApiError);
        expect((e as FakturoidApiError).code).toBe('INVALID_API_KEY');
        expect((e as FakturoidApiError).status).toBe(401);
      }
    });

    // Fakturoid documents 403 for business rules, not for authentication: a
    // locked document, no bank account on the account, the subject limit
    // reached, a payment on an invoice that is already paid. Reporting it as
    // INVALID_API_KEY sent callers to re-check credentials that were fine.
    it('throws FORBIDDEN on 403, not INVALID_API_KEY', async () => {
      mockTokenAndResponse('Forbidden', 403);
      try {
        await client.getAccount();
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(FakturoidApiError);
        expect((e as FakturoidApiError).code).toBe('FORBIDDEN');
        expect((e as FakturoidApiError).status).toBe(403);
      }
    });

    it('throws PAYMENT_REQUIRED on 402', async () => {
      // Not a plan upsell: Fakturoid answers 402 when it has blocked the
      // account over its own unpaid invoice.
      mockTokenAndResponse('Payment Required', 402);
      try {
        await client.getAccount();
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(FakturoidApiError);
        expect((e as FakturoidApiError).code).toBe('PAYMENT_REQUIRED');
      }
    });

    it('throws NOT_FOUND on 404', async () => {
      mockTokenAndResponse('Not Found', 404);
      try {
        await client.getInvoice({ id: 999 });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(FakturoidApiError);
        expect((e as FakturoidApiError).code).toBe('NOT_FOUND');
      }
    });

    it('throws RATE_LIMITED on 429', async () => {
      mockTokenAndResponse('Too Many Requests', 429);
      try {
        await client.getAccount();
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(FakturoidApiError);
        expect((e as FakturoidApiError).code).toBe('RATE_LIMITED');
      }
    });

    it('throws BAD_REQUEST on 400', async () => {
      mockTokenAndResponse('Bad Request', 400);
      try {
        await client.createInvoice({});
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(FakturoidApiError);
        expect((e as FakturoidApiError).code).toBe('BAD_REQUEST');
      }
    });

    it('throws UNPROCESSABLE on 422', async () => {
      mockTokenAndResponse('Unprocessable Entity', 422);
      try {
        await client.createInvoice({});
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(FakturoidApiError);
        expect((e as FakturoidApiError).code).toBe('UNPROCESSABLE');
      }
    });

    it('throws API_ERROR on 500', async () => {
      mockTokenAndResponse('Server Error', 500);
      try {
        await client.getAccount();
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(FakturoidApiError);
        expect((e as FakturoidApiError).code).toBe('API_ERROR');
      }
    });

    it('DELETE 204 returns undefined', async () => {
      mockTokenAndResponse(undefined, 204);
      const result = await client.deleteInvoice({ id: 1 });
      expect(result).toBeUndefined();
    });

    it('POST 204 (fire.json) returns undefined', async () => {
      mockTokenAndResponse(undefined, 204);
      const result = await client.invoiceAction({ id: 1, event: 'pay' });
      expect(result).toBeUndefined();
    });
  });

  // ── validateApiKey ───────────────────────────────────────────────────

  describe('validateApiKey', () => {
    it('returns valid: true on success', async () => {
      mockTokenAndResponse({ name: 'Test Account' });
      const result = await client.validateApiKey();
      expect(result).toEqual({ valid: true });
    });

    it('returns valid: false on 401', async () => {
      mockTokenAndResponse('Unauthorized', 401);
      const result = await client.validateApiKey();
      expect(result).toEqual({
        valid: false,
        error: 'Invalid OAuth credentials or account slug',
      });
    });

    // Splitting 403 off into FORBIDDEN would have silently turned a rejected
    // key into "valid" here: elsewhere a 403 is a business rule, but no
    // business rule can forbid reading your own account.
    it('returns valid: false on 403 too, now that it maps to FORBIDDEN', async () => {
      mockTokenAndResponse('Forbidden', 403);
      const result = await client.validateApiKey();
      expect(result).toEqual({
        valid: false,
        error: 'Invalid OAuth credentials or account slug',
      });
    });

    it('returns valid: false on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await client.validateApiKey();
      expect(result).toEqual({
        valid: false,
        error: expect.stringContaining('ECONNREFUSED'),
      });
    });
  });
  // ── Error message shape ───────────────────────────────────────

  describe('FakturoidApiError message', () => {
    it('does not prefix the code onto the message', () => {
      // The server reports the code as its own field. Prefixing it here
      // produced `{"error":"BAD_REQUEST","message":"BAD_REQUEST: ..."}` — the
      // code twice, and a message the caller had to strip before reading it.
      const error = new FakturoidApiError('boom', 400, 'BAD_REQUEST');
      expect(error.message).toBe('boom');
      expect(error.message).not.toContain('BAD_REQUEST');
    });

    it('carries the upstream body verbatim as the message', async () => {
      mockTokenAndResponse({ errors: { number: ['is already taken'] } }, 422);
      try {
        await client.createInvoice({});
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as FakturoidApiError).message).toBe('{"errors":{"number":["is already taken"]}}');
        expect((e as FakturoidApiError).message).not.toContain('UNPROCESSABLE');
      }
    });

    it('attaches a hint that tells FORBIDDEN apart from a credential problem', async () => {
      mockTokenAndResponse('Forbidden', 403);
      try {
        await client.getAccount();
        expect.fail('Should have thrown');
      } catch (e) {
        const hint = (e as FakturoidApiError).hint;
        expect(hint).toBeDefined();
        expect(hint).toContain('credentials are fine');
      }
    });

    it('leaves the hint undefined for an unclassified status', async () => {
      mockTokenAndResponse('Server Error', 500);
      try {
        await client.getAccount();
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as FakturoidApiError).code).toBe('API_ERROR');
        expect((e as FakturoidApiError).hint).toBeUndefined();
      }
    });
  });
});
