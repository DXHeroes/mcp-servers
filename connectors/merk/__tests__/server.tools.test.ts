/**
 * Unit tests for MerkMcpServer — per-tool `callTool` routing and argument shaping.
 *
 * Shared setup lives in `server.helpers.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MerkMcpServer } from '../src/server.js';
import {
  createInitializedServer,
  merkClientMocks,
  mockCompanyBatch,
  mockCompanyEvents,
  mockCompanyLookup,
  mockEnums,
  mockRelationsCompany,
  mockRelationsShortestPath,
  mockSearchCompanies,
  mockSuggest,
  mockVokativ,
  resetMerkClientMocks,
} from './server.helpers.js';

vi.mock('../src/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/client.js')>();
  return {
    ...original,
    MerkClient: class MockMerkClient {
      constructor() {
        Object.assign(this, merkClientMocks);
      }
    },
  };
});

describe('MerkMcpServer', () => {
  beforeEach(resetMerkClientMocks);

  describe('callTool - merk_company_lookup', () => {
    let server: MerkMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should return company data on success', async () => {
      mockCompanyLookup.mockResolvedValue({ regno: '12345678', name: 'Test Corp' });

      const result = (await server.callTool('merk_company_lookup', {
        regno: '12345678',
      })) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0]?.type).toBe('text');
      const data = JSON.parse(String(result.content[0]?.text));
      expect(data.regno).toBe('12345678');
    });

    it('should return error for invalid input (missing required params)', async () => {
      const result = (await server.callTool('merk_company_lookup', {})) as {
        isError: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('INVALID_INPUT');
    });
  });

  describe('callTool - merk_company_batch', () => {
    let server: MerkMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should return batch results', async () => {
      mockCompanyBatch.mockResolvedValue({ results: [{ regno: '1' }] });

      const result = (await server.callTool('merk_company_batch', {
        regnos: ['12345678'],
      })) as { content: Array<{ text: string }> };

      const data = JSON.parse(String(result.content[0]?.text));
      expect(data.results).toHaveLength(1);
    });
  });

  describe('callTool - merk_search_companies', () => {
    let server: MerkMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should search with country and filters', async () => {
      mockSearchCompanies.mockResolvedValue({ results: [] });

      await server.callTool('merk_search_companies', {
        country: 'cz',
        filters: { name: 'Test' },
      });

      expect(mockSearchCompanies).toHaveBeenCalledWith({
        country: 'cz',
        filters: { name: 'Test' },
      });
    });

    it('should accept docs-native top-level search parameters', async () => {
      mockSearchCompanies.mockResolvedValue({ results: [] });

      await server.callTool('merk_search_companies', {
        country: 'cz',
        query: 'strojirenstvi',
        ordering: ['name'],
        magnitude_from: 'small',
        magnitude_to: 'medium',
      });

      expect(mockSearchCompanies).toHaveBeenCalledWith({
        country: 'cz',
        query: 'strojirenstvi',
        ordering: ['name'],
        magnitude_from: 'small',
        magnitude_to: 'medium',
      });
    });

    it('should default search country to cz when omitted', async () => {
      mockSearchCompanies.mockResolvedValue({ results: [] });

      await server.callTool('merk_search_companies', {
        query: 'vyroba',
      });

      expect(mockSearchCompanies).toHaveBeenCalledWith({
        country: 'cz',
        query: 'vyroba',
      });
    });
  });

  describe('callTool - merk_company_suggest', () => {
    let server: MerkMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should accept query and country aliases from the screenshot regression', async () => {
      mockSuggest.mockResolvedValue({ results: [] });

      await server.callTool('merk_company_suggest', {
        query: 'strojirenstvi vyroba Praha',
        country: 'cz',
      });

      expect(mockSuggest).toHaveBeenCalledWith({
        query: 'strojirenstvi vyroba Praha',
        country: 'cz',
      });
    });

    it('should reject an empty suggest request', async () => {
      const result = (await server.callTool('merk_company_suggest', {})) as {
        isError: boolean;
        content: Array<{ text: string }>;
      };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('INVALID_INPUT');
    });
  });

  describe('callTool - merk_company_events', () => {
    let server: MerkMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should accept date range filters without regno', async () => {
      mockCompanyEvents.mockResolvedValue({ results: [] });

      await server.callTool('merk_company_events', {
        from_date: '2024-01-01',
        to_date: '2024-01-31',
        event_id: 1,
        action_id: 2,
      });

      expect(mockCompanyEvents).toHaveBeenCalledWith({
        from_date: '2024-01-01',
        to_date: '2024-01-31',
        event_id: 1,
        action_id: 2,
      });
    });
  });

  describe('callTool - merk_relations_company', () => {
    let server: MerkMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should accept regno alias for the relations company regression', async () => {
      mockRelationsCompany.mockResolvedValue({ list_of_graph_items: [] });

      await server.callTool('merk_relations_company', {
        regno: '12345678',
        country_code: 'cz',
        relation_type: 'current',
      });

      expect(mockRelationsCompany).toHaveBeenCalledWith({
        regno: '12345678',
        country_code: 'cz',
        relation_type: 'current',
      });
    });
  });

  describe('callTool - merk_relations_shortest_path', () => {
    let server: MerkMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should find shortest path', async () => {
      mockRelationsShortestPath.mockResolvedValue({ path: [{ id: '1' }, { id: '2' }] });

      const result = (await server.callTool('merk_relations_shortest_path', {
        node1_id: '1',
        node1_label: 'company',
        node2_id: '2',
        node2_label: 'person',
        relation_type: 'current',
      })) as { content: Array<{ text: string }> };

      const data = JSON.parse(String(result.content[0]?.text));
      expect(data.path).toHaveLength(2);
    });

    it('should require relation_type for the documented shortest path contract', async () => {
      const result = (await server.callTool('merk_relations_shortest_path', {
        node1_id: '1',
        node1_label: 'company',
        node2_id: '2',
        node2_label: 'person',
      })) as { content: Array<{ text: string }>; isError: boolean };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('INVALID_INPUT');
    });
  });

  describe('callTool - merk_enums', () => {
    let server: MerkMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should return all enums when no id', async () => {
      mockEnums.mockResolvedValue([{ id: 'legal_form' }]);
      const result = (await server.callTool('merk_enums', {})) as {
        content: Array<{ text: string }>;
      };
      const data = JSON.parse(String(result.content[0]?.text));
      expect(data).toHaveLength(1);
    });

    it('should accept id and country_code parameters', async () => {
      mockEnums.mockResolvedValue([{ id: 'company_status' }]);

      await server.callTool('merk_enums', {
        id: 'company_status',
        country_code: 'cz',
      });

      expect(mockEnums).toHaveBeenCalledWith({
        id: 'company_status',
        country_code: 'cz',
      });
    });
  });

  describe('callTool - merk_vokativ', () => {
    let server: MerkMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should return vocative form', async () => {
      mockVokativ.mockResolvedValue({ vokativ: 'Jene' });
      const result = (await server.callTool('merk_vokativ', {
        first_name: 'Jan',
        last_name: 'Novák',
      })) as { content: Array<{ text: string }> };

      const data = JSON.parse(String(result.content[0]?.text));
      expect(data.vokativ).toBe('Jene');
    });

    it('should allow a single name field', async () => {
      mockVokativ.mockResolvedValue({ first_name: 'Jene' });

      const result = (await server.callTool('merk_vokativ', {
        first_name: 'Jan',
      })) as { content: Array<{ text: string }> };

      const data = JSON.parse(String(result.content[0]?.text));
      expect(data.first_name).toBe('Jene');
      expect(mockVokativ).toHaveBeenCalledWith({
        first_name: 'Jan',
      });
    });
  });
});
