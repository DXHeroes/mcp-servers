/**
 * Unit tests for MerkClient — suggest and search.
 *
 * Tests mock global.fetch to verify HTTP requests are constructed correctly.
 * Shared setup lives in `client.helpers.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MerkClient } from '../src/client.js';
import { beginClientTest, endClientTest, mockFetch, mockResponse } from './client.helpers.js';

describe('MerkClient', () => {
  let client: MerkClient;

  beforeEach(() => {
    client = beginClientTest();
  });

  afterEach(endClientTest);

  describe('suggest', () => {
    it('should call GET /suggest/ with name param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.suggest({ name: 'Test' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/suggest/?name=Test',
        expect.any(Object),
      );
    });

    it('should support email param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.suggest({ email: 'test@example.com' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/suggest/?email=test%40example.com',
        expect.any(Object),
      );
    });

    it('should support bank_account param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.suggest({ bank_account: '123456/0100' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/suggest/?bank_account=123456%2F0100',
        expect.any(Object),
      );
    });

    it('should support only_active param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.suggest({ name: 'Test', only_active: true });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/suggest/?name=Test&only_active=true',
        expect.any(Object),
      );
    });

    it('should normalize query and country aliases from the screenshot regression', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.suggest({ query: 'Test', country: 'cz' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/suggest/?name=Test&country_code=cz',
        expect.any(Object),
      );
    });

    it('should support regno and expand_regno params', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.suggest({ regno: '12345678', expand_regno: true });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/suggest/?regno=12345678&expand_regno=true',
        expect.any(Object),
      );
    });

    it('should support include_historic and sort_by params', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.suggest({ name: 'Test', include_historic: true, sort_by: 'name' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/suggest/?name=Test&sort_by=name&include_historic=true',
        expect.any(Object),
      );
    });
  });

  describe('searchCompanies', () => {
    it('should call POST /search/cz/ for Czech companies', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.searchCompanies({ country: 'cz', filters: { name: 'Test' } });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/search/cz/',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'Test' }),
        }),
      );
    });

    it('should call POST /search/sk/ for Slovak companies', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.searchCompanies({ country: 'sk', filters: { name: 'Test' } });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/search/sk/',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should pass page and page_size params', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.searchCompanies({
        country: 'cz',
        filters: {},
        page: 2,
        page_size: 50,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/search/cz/?page=2&page_size=50',
        expect.any(Object),
      );
    });

    it('should send docs-native query params and top-level body fields', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.searchCompanies({
        country: 'cz',
        query: 'strojirenstvi',
        ordering: ['name'],
        magnitude_from: 'small',
        magnitude_to: 'medium',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/search/cz/?query=strojirenstvi&ordering=name',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            magnitude_from: 'small',
            magnitude_to: 'medium',
          }),
        }),
      );
    });

    it('should merge legacy filters into the top-level request body', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.searchCompanies({
        country: 'cz',
        query: 'test',
        filters: { turnover_from: 'small' },
        magnitude_to: 'medium',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/search/cz/?query=test',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            turnover_from: 'small',
            magnitude_to: 'medium',
          }),
        }),
      );
    });

    it('should default search country to cz and map limit to page_size', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.searchCompanies({
        query: 'vyroba',
        limit: 10,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/search/cz/?query=vyroba&page_size=10',
        expect.any(Object),
      );
    });
  });

  describe('suggest - additional params', () => {
    it('should pass country_code param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.suggest({ name: 'Test', country_code: 'cz' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('country_code=cz'),
        expect.any(Object),
      );
    });

    it('should pass sort_by param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.suggest({ name: 'Test', sort_by: 'turnover' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('sort_by=turnover'),
        expect.any(Object),
      );
    });

    it('should pass expand_regno param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.suggest({ regno: '123', expand_regno: true });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('expand_regno=true'),
        expect.any(Object),
      );
    });

    it('should pass include_historic param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.suggest({ name: 'Test', include_historic: true });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('include_historic=true'),
        expect.any(Object),
      );
    });
  });

  describe('searchCompanies - query param', () => {
    it('should pass query as URL query param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.searchCompanies({ country: 'cz', query: 'strojírenství', filters: {} });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('query=stroj'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should pass ordering as URL query param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.searchCompanies({
        country: 'cz',
        ordering: ['-turnover_id', 'name'],
        filters: {},
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('ordering=-turnover_id'),
        expect.any(Object),
      );
    });
  });
});
