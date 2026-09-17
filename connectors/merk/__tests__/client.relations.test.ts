/**
 * Unit tests for MerkClient — relations, enums and account endpoints.
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

  describe('relationsCompany', () => {
    it('should call GET /relations/company/ with company_id and relation_type', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.relationsCompany({ company_id: '42', relation_type: 'current' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/relations/company/?company_id=42&relation_type=current',
        expect.any(Object),
      );
    });

    it('should build company_id from regno and country_code aliases', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.relationsCompany({
        regno: '12345678',
        country_code: 'cz',
        relation_type: 'current',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/relations/company/?company_id=cz-12345678&relation_type=current&country_code=cz',
        expect.any(Object),
      );
    });
  });

  describe('relationsPerson', () => {
    it('should call GET /relations/person/ with person_id and relation_type', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.relationsPerson({ person_id: '99', relation_type: 'current' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/relations/person/?person_id=99&relation_type=current',
        expect.any(Object),
      );
    });
  });

  describe('relationsSearchPerson', () => {
    it('should call GET /relations/search/person/ with name', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.relationsSearchPerson({ name: 'Jan Novák' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/relations/search/person/?name=Jan'),
        expect.any(Object),
      );
    });

    it('should support birth_date param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.relationsSearchPerson({ name: 'Jan', birth_date: '1990-01-01' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('birth_date=1990-01-01'),
        expect.any(Object),
      );
    });
  });

  describe('relationsShortestPath', () => {
    it('should call GET /relations/shortest-path/ with all required params', async () => {
      mockFetch.mockResolvedValue(mockResponse({ path: [] }));
      await client.relationsShortestPath({
        node1_id: '1',
        node1_label: 'company',
        node2_id: '2',
        node2_label: 'person',
        relation_type: 'current',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/relations/shortest-path/'),
        expect.any(Object),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('node1_id=1'),
        expect.any(Object),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('node2_label=person'),
        expect.any(Object),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('relation_type=current'),
        expect.any(Object),
      );
    });

    it('should support country_code and hops params', async () => {
      mockFetch.mockResolvedValue(mockResponse({ path: [] }));
      await client.relationsShortestPath({
        node1_id: '1',
        node1_label: 'company',
        node2_id: '2',
        node2_label: 'person',
        relation_type: 'current',
        country_code: 'cz',
        hops: 2,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/relations/shortest-path/?node1_id=1&node1_label=company&node2_id=2&node2_label=person&relation_type=current&country_code=cz&hops=2',
        expect.any(Object),
      );
    });
  });

  describe('enums', () => {
    it('should call GET /enums/ without id', async () => {
      mockFetch.mockResolvedValue(mockResponse({ results: [] }));
      await client.enums({});
      expect(mockFetch).toHaveBeenCalledWith('https://api.merk.cz/enums/', expect.any(Object));
    });

    it('should call GET /enums/{id}/ with id', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 'legal_form', values: [] }));
      await client.enums({ enum_id: 'legal_form' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/enums/legal_form/',
        expect.any(Object),
      );
    });

    it('should support id alias and country_code', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 'company_status', values: [] }));
      await client.enums({ id: 'company_status', country_code: 'cz' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/enums/company_status/?country_code=cz',
        expect.any(Object),
      );
    });
  });

  describe('subscriptionInfo', () => {
    it('should call GET /subscriptions/', async () => {
      mockFetch.mockResolvedValue(mockResponse({ plan: 'pro', credits: 100 }));
      const result = await client.subscriptionInfo();
      expect(result).toEqual({ plan: 'pro', credits: 100 });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/subscriptions/',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('vokativ', () => {
    it('should call GET /vokativ/ with first_name and last_name', async () => {
      mockFetch.mockResolvedValue(mockResponse({ vokativ: 'Jene' }));
      await client.vokativ({ first_name: 'Jan', last_name: 'Novák' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/vokativ/?first_name=Jan'),
        expect.any(Object),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('last_name=Nov'),
        expect.any(Object),
      );
    });

    it('should allow only first_name', async () => {
      mockFetch.mockResolvedValue(mockResponse({ first_name: 'Jene' }));
      await client.vokativ({ first_name: 'Jan' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.merk.cz/vokativ/?first_name=Jan',
        expect.any(Object),
      );
    });
  });

  describe('relationsCompany - additional params', () => {
    it('should pass hops param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ nodes: [], edges: [] }));
      await client.relationsCompany({
        company_id: 'cz-12345678',
        relation_type: 'current',
        hops: 2,
      });
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('hops=2'), expect.any(Object));
    });

    it('should pass share_gte param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ nodes: [], edges: [] }));
      await client.relationsCompany({
        company_id: 'cz-12345678',
        relation_type: 'any',
        share_gte: 50,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('share_gte=50'),
        expect.any(Object),
      );
    });
  });

  describe('relationsShortestPath - hops param', () => {
    it('should pass hops param', async () => {
      mockFetch.mockResolvedValue(mockResponse({ path: [] }));
      await client.relationsShortestPath({
        node1_id: '1',
        node1_label: 'company',
        node2_id: '2',
        node2_label: 'person',
        relation_type: 'current',
        hops: 3,
      });
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('hops=3'), expect.any(Object));
    });
  });
});
