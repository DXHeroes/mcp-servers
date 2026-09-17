/**
 * Unit tests for MerkClient — company data endpoints.
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

  describe('financialStatements', () => {
    it('should call GET /company/financial-statements/ with regno', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.financialStatements({ regno: '12345678' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/financial-statements/?regno=12345678',
        expect.any(Object),
      );
    });

    it('should support country_code', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.financialStatements({ regno: '12345678', country_code: 'sk' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/financial-statements/?regno=12345678&country_code=sk',
        expect.any(Object),
      );
    });
  });

  describe('financialIndicators', () => {
    it('should call GET /company/financial-indicators/ with regno', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.financialIndicators({ regno: '12345678' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/financial-indicators/?regno=12345678',
        expect.any(Object),
      );
    });
  });

  describe('companyEmployees', () => {
    it('should call GET /company/employees/ with regno', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyEmployees({ regno: '12345678' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/employees/?regno=12345678',
        expect.any(Object),
      );
    });
  });

  describe('companyFleet', () => {
    it('should call GET /company/fleet/ with regno', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyFleet({ regno: '12345678' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/fleet/?regno=12345678',
        expect.any(Object),
      );
    });
  });

  describe('companyFleetStats', () => {
    it('should call GET /company/fleet-stats/ with regno', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyFleetStats({ regno: '12345678' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/fleet-stats/?regno=12345678',
        expect.any(Object),
      );
    });
  });

  describe('companyBusinessPremises', () => {
    it('should call GET /company/business-premises/ with regno', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyBusinessPremises({ regno: '12345678' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/business-premises/?regno=12345678',
        expect.any(Object),
      );
    });
  });

  describe('companyLicenses', () => {
    it('should call GET /company/licenses/ with regno', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyLicenses({ regno: '12345678' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/licenses/?regno=12345678',
        expect.any(Object),
      );
    });
  });

  describe('companyEvents', () => {
    it('should call GET /company/events/ with regno and required dates', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyEvents({
        regno: '12345678',
        from_date: '2024-01-01',
        to_date: '2024-12-31',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/events/?regno=12345678&from_date=2024-01-01&to_date=2024-12-31',
        expect.any(Object),
      );
    });

    it('should support from_date and to_date params', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyEvents({
        regno: '12345678',
        from_date: '2024-01-01',
        to_date: '2024-12-31',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/events/?regno=12345678&from_date=2024-01-01&to_date=2024-12-31',
        expect.any(Object),
      );
    });

    it('should support company-wide date filters without regno', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyEvents({
        from_date: '2024-01-01',
        to_date: '2024-12-31',
        event_id: 1,
        action_id: 2,
        country_code: 'cz',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/events/?from_date=2024-01-01&to_date=2024-12-31&event_id=1&action_id=2&country_code=cz',
        expect.any(Object),
      );
    });
  });

  describe('newCompanies', () => {
    it('should call GET /company/new2/ with date params', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.newCompanies({ from_date: '2024-01-01', to_date: '2024-01-31' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/new2/?from_date=2024-01-01&to_date=2024-01-31',
        expect.any(Object),
      );
    });

    it('should support country_code param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.newCompanies({
        from_date: '2024-01-01',
        to_date: '2024-01-31',
        country_code: 'sk',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('country_code=sk'),
        expect.any(Object),
      );
    });

    it('should support page and page_size', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.newCompanies({
        from_date: '2024-01-01',
        to_date: '2024-01-31',
        page: 2,
        page_size: 50,
      });
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('page=2'), expect.any(Object));
    });
  });

  describe('updatedCompanies', () => {
    it('should call GET /company/updates2/ with date params', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.updatedCompanies({ from_date: '2024-01-01', to_date: '2024-01-31' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/updates2/?from_date=2024-01-01&to_date=2024-01-31',
        expect.any(Object),
      );
    });
  });

  describe('companyJobAds', () => {
    it('should call GET /company/job-ads/ with regno', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyJobAds({ regno: '12345678' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/job-ads/?regno=12345678',
        expect.any(Object),
      );
    });
  });

  describe('companyGovContracts', () => {
    it('should call GET /company/gov-contracts/ with regno', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyGovContracts({ regno: '12345678' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/company/gov-contracts/?regno=12345678',
        expect.any(Object),
      );
    });
  });

  describe('pagination support', () => {
    it('should pass page and page_size to companyEmployees', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyEmployees({ regno: '123', page: 3, page_size: 25 });
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('page=3'), expect.any(Object));
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('page_size=25'),
        expect.any(Object),
      );
    });
  });

  describe('country_code on regno endpoints', () => {
    it('should pass country_code to financialStatements', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.financialStatements({ regno: '123', country_code: 'sk' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('country_code=sk'),
        expect.any(Object),
      );
    });

    it('should pass country_code to companyFleet', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyFleet({ regno: '123', country_code: 'cz' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('country_code=cz'),
        expect.any(Object),
      );
    });
  });

  describe('companyEvents - required dates and filters', () => {
    it('should pass action_id and event_id', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.companyEvents({
        regno: '123',
        from_date: '2024-01-01',
        to_date: '2024-12-31',
        action_id: 5,
        event_id: 10,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('action_id=5'),
        expect.any(Object),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('event_id=10'),
        expect.any(Object),
      );
    });
  });
});
