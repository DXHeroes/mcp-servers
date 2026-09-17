/**
 * Unit tests for MerkClient — lookup, batch and key validation.
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

  describe('constructor', () => {
    it('should store apiKey and use default baseUrl', async () => {
      const c = new MerkClient('my-key');
      // Verify by making a request and checking the URL
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      // Awaited, not fire-and-forget: `safeFetch` validates the host before it
      // reaches `fetch`, so the call no longer lands in the same microtask.
      await c.subscriptionInfo();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://api.merk.cz'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Token my-key',
          }),
        }),
      );
    });

    it('should allow custom baseUrl', async () => {
      const c = new MerkClient('my-key', 'https://custom.api.com');
      mockFetch.mockResolvedValue(mockResponse({}));
      await c.subscriptionInfo();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://custom.api.com'),
        expect.any(Object),
      );
    });
  });

  describe('validateApiKey', () => {
    it('should return valid: true on 200 response', async () => {
      mockFetch.mockResolvedValue(mockResponse({ plan: 'pro' }));
      const result = await client.validateApiKey();
      expect(result).toEqual({ valid: true });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/subscriptions/',
        expect.objectContaining({
          method: 'GET',
          headers: { Authorization: 'Token test-api-key-123' },
        }),
      );
    });

    it('should return invalid on 401 response', async () => {
      mockFetch.mockResolvedValue(mockResponse({ detail: 'Invalid token' }, 401));
      const result = await client.validateApiKey();
      expect(result).toEqual({ valid: false, error: 'Invalid API key' });
    });

    it('should return invalid on 403 response', async () => {
      mockFetch.mockResolvedValue(mockResponse({ detail: 'Forbidden' }, 403));
      const result = await client.validateApiKey();
      expect(result).toEqual({ valid: false, error: 'Invalid API key' });
    });

    it('should return error on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await client.validateApiKey();
      expect(result).toEqual({ valid: false, error: 'Validation failed: ECONNREFUSED' });
    });
  });

  describe('companyLookup', () => {
    it('should call GET /company/ with regno query param', async () => {
      const mockData = { regno: '12345678', name: 'Test Corp' };
      mockFetch.mockResolvedValue(mockResponse(mockData));

      const result = await client.companyLookup({ regno: '12345678' });

      expect(result).toEqual(mockData);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/?regno=12345678',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should support vatno param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ vatno: 'CZ12345678' }));
      await client.companyLookup({ vatno: 'CZ12345678' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/?vatno=CZ12345678',
        expect.any(Object),
      );
    });

    it('should support country_code param', async () => {
      mockFetch.mockResolvedValue(mockResponse({}));
      await client.companyLookup({ regno: '123', country_code: 'sk' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/?regno=123&country_code=sk',
        expect.any(Object),
      );
    });

    it('should support src_app param', async () => {
      mockFetch.mockResolvedValue(mockResponse({}));
      await client.companyLookup({ regno: '123', src_app: 'local-mcp-ui' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/?regno=123&src_app=local-mcp-ui',
        expect.any(Object),
      );
    });

    it('should throw MerkApiError on 404', async () => {
      mockFetch.mockResolvedValue(mockResponse({ detail: 'Not found' }, 404));
      await expect(client.companyLookup({ regno: '99999999' })).rejects.toThrow(MerkApiError);
      // The code used to be prefixed onto the message, so `/NOT_FOUND/` matched
      // the message text. It no longer is — the code lives in its own field.
      await expect(client.companyLookup({ regno: '99999999' })).rejects.toThrow('Not found');
    });
  });

  describe('companyBatch', () => {
    it('should call POST /company/mget/ with regnos body', async () => {
      const mockData = { results: [{ regno: '1' }, { regno: '2' }] };
      mockFetch.mockResolvedValue(mockResponse(mockData));

      const result = await client.companyBatch({ regnos: ['1', '2'] });

      expect(result).toEqual(mockData);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/mget/',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ regnos: ['1', '2'] }),
        }),
      );
    });

    it('should throw if regnos exceeds 500', async () => {
      const regnos = Array.from({ length: 501 }, (_, i) => String(i));
      await expect(client.companyBatch({ regnos })).rejects.toThrow(/500/);
    });

    it('should include country_code and src_app in the request body', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyBatch({
        regnos: ['1', '2'],
        country_code: 'cz',
        src_app: 'local-mcp-ui',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/mget/',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            regnos: ['1', '2'],
            country_code: 'cz',
            src_app: 'local-mcp-ui',
          }),
        }),
      );
    });
  });

  describe('companyBatch - country_code', () => {
    it('should pass country_code in body', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyBatch({ regnos: ['1'], country_code: 'sk' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/mget/',
        expect.objectContaining({
          body: JSON.stringify({ regnos: ['1'], country_code: 'sk' }),
        }),
      );
    });
  });
});
