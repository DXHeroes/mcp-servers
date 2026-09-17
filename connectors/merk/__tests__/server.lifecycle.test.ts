/**
 * Unit tests for MerkMcpServer — construction, validation and capability listing.
 *
 * Shared setup lives in `server.helpers.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MerkMcpServer } from '../src/server.js';
import {
  apiKeyConfig,
  createInitializedServer,
  merkClientMocks,
  mockCompanyLookup,
  mockValidateApiKey,
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

  describe('initialize', () => {
    it('should initialize with valid API key', async () => {
      const server = new MerkMcpServer(apiKeyConfig);
      await server.initialize();

      // Should be able to call tools
      mockCompanyLookup.mockResolvedValue({ regno: '123' });
      const result = (await server.callTool('merk_company_lookup', {
        regno: '12345678',
      })) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
    });

    it('should set error when no API key is provided', async () => {
      const server = new MerkMcpServer(null);
      await server.initialize();

      const result = (await server.callTool('merk_company_lookup', {
        regno: '12345678',
      })) as {
        isError: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('API_KEY_REQUIRED');
    });

    it('should set error when API key is empty', async () => {
      const server = new MerkMcpServer({ ...apiKeyConfig, apiKey: '' });
      await server.initialize();

      const result = (await server.callTool('merk_company_lookup', {
        regno: '12345678',
      })) as { isError: boolean };
      expect(result.isError).toBe(true);
    });
  });

  describe('validate', () => {
    it('should delegate to MerkClient.validateApiKey', async () => {
      const server = new MerkMcpServer(apiKeyConfig);
      await server.initialize();

      mockValidateApiKey.mockResolvedValue({ valid: true });
      const result = await server.validate();
      expect(result).toEqual({ valid: true });
    });

    it('should return invalid when no API key configured', async () => {
      const server = new MerkMcpServer(null);
      await server.initialize();

      const result = await server.validate();
      expect(result).toEqual({ valid: false, error: 'API key not configured' });
    });
  });

  describe('listTools', () => {
    it('should return 23 tools', async () => {
      const server = new MerkMcpServer(apiKeyConfig);
      await server.initialize();

      const tools = await server.listTools();
      expect(tools).toHaveLength(23);
    });

    it('should have correct tool names', async () => {
      const server = new MerkMcpServer(apiKeyConfig);
      await server.initialize();

      const tools = await server.listTools();
      const names = tools.map((t) => t.name);

      expect(names).toContain('merk_company_lookup');
      expect(names).toContain('merk_company_batch');
      expect(names).toContain('merk_company_suggest');
      expect(names).toContain('merk_search_companies');
      expect(names).toContain('merk_financial_statements');
      expect(names).toContain('merk_financial_indicators');
      expect(names).toContain('merk_company_employees');
      expect(names).toContain('merk_company_fleet');
      expect(names).toContain('merk_company_fleet_stats');
      expect(names).toContain('merk_company_business_premises');
      expect(names).toContain('merk_company_licenses');
      expect(names).toContain('merk_company_events');
      expect(names).toContain('merk_new_companies');
      expect(names).toContain('merk_updated_companies');
      expect(names).toContain('merk_company_job_ads');
      expect(names).toContain('merk_company_gov_contracts');
      expect(names).toContain('merk_relations_company');
      expect(names).toContain('merk_relations_person');
      expect(names).toContain('merk_relations_search_person');
      expect(names).toContain('merk_relations_shortest_path');
      expect(names).toContain('merk_enums');
      expect(names).toContain('merk_subscription_info');
      expect(names).toContain('merk_vokativ');
    });

    it('should have inputSchema on each tool', async () => {
      const server = new MerkMcpServer(apiKeyConfig);
      await server.initialize();

      const tools = await server.listTools();
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
      }
    });

    it('should have description on each tool', async () => {
      const server = new MerkMcpServer(apiKeyConfig);
      await server.initialize();

      const tools = await server.listTools();
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
      }
    });
  });

  describe('listResources', () => {
    it('should return empty array', async () => {
      const server = new MerkMcpServer(apiKeyConfig);
      const resources = await server.listResources();
      expect(resources).toEqual([]);
    });
  });
  // ── MCP annotations (the operator's only lever) ─────────────────────

  describe('tool annotations', () => {
    let server: MerkMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should annotate every tool, so none defaults into the write group', async () => {
      const tools = await server.listTools();
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toBeDefined();
        expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      }
    });

    it('should mark all 23 tools read-only', async () => {
      const tools = await server.listTools();
      const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true);
      // Pinned, not floored. A floor would let a tool quietly lose its
      // annotation and slide into the write group unnoticed, which is the
      // whole failure this block exists to catch. The split is
      // 23 read-only + 0 writes = 23: MerkClient speaks only GET and POST, and
      // both of its POSTs (/company/mget/, /search/{country}/) are queries
      // whose input is too large for a query string.
      expect(tools.length).toBe(23);
      expect(readOnly.length).toBe(23);
    });

    it('should not mark any tool destructive', async () => {
      // The interesting guard here. Merk exposes nothing that writes today; if
      // someone adds a delete tool and copies an existing annotation with it,
      // this fails and forces the annotation to be thought about.
      const tools = await server.listTools();
      const destructive = tools.filter((t) => t.annotations?.destructiveHint === true);
      expect(destructive.map((t) => t.name)).toEqual([]);
    });

    it('should never mark a tool both read-only and destructive', async () => {
      const tools = await server.listTools();
      for (const tool of tools.filter((t) => t.annotations?.destructiveHint === true)) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
      }
    });

    it('should not put a DESTRUCTIVE marker in any description', async () => {
      const tools = await server.listTools();
      for (const tool of tools) {
        expect(tool.description, tool.name).not.toContain('DESTRUCTIVE');
      }
    });
  });
});
