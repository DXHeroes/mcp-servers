/**
 * Unit tests for MerkMcpServer — unknown tools, upstream failures, empty bodies
 * and the shape of the error payload the model ends up reading.
 *
 * Shared setup lives in `server.helpers.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MerkMcpServer } from '../src/server.js';
import {
  apiKeyConfig,
  createInitializedServer,
  merkClientMocks,
  mockCompanyEmployees,
  mockCompanyLookup,
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

  describe('callTool - unknown tool', () => {
    it('should return error for unknown tool name', async () => {
      const server = new MerkMcpServer(apiKeyConfig);
      await server.initialize();

      const result = (await server.callTool('unknown_tool', {})) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('UNKNOWN_TOOL');
    });
  });

  describe('callTool - API error handling', () => {
    let server: MerkMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should handle MerkApiError with INVALID_API_KEY code', async () => {
      const { MerkApiError } = await import('../src/client.js');
      mockCompanyLookup.mockRejectedValue(new MerkApiError('Unauthorized', 401, 'INVALID_API_KEY'));

      const result = (await server.callTool('merk_company_lookup', {
        regno: '12345678',
      })) as { content: Array<{ text: string }>; isError: boolean };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('INVALID_API_KEY');
    });

    it('should handle MerkApiError with RATE_LIMITED code', async () => {
      const { MerkApiError } = await import('../src/client.js');
      mockCompanyLookup.mockRejectedValue(new MerkApiError('Too many', 429, 'RATE_LIMITED'));

      const result = (await server.callTool('merk_company_lookup', {
        regno: '12345678',
      })) as { content: Array<{ text: string }>; isError: boolean };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('RATE_LIMITED');
    });

    it('should handle MerkApiError with NOT_FOUND code', async () => {
      const { MerkApiError } = await import('../src/client.js');
      mockCompanyLookup.mockRejectedValue(new MerkApiError('Not found', 404, 'NOT_FOUND'));

      const result = (await server.callTool('merk_company_lookup', {
        regno: '12345678',
      })) as { content: Array<{ text: string }>; isError: boolean };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('NOT_FOUND');
    });

    it('should handle generic errors', async () => {
      mockCompanyLookup.mockRejectedValue(new Error('Network error'));

      const result = (await server.callTool('merk_company_lookup', {
        regno: '12345678',
      })) as { content: Array<{ text: string }>; isError: boolean };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('API_ERROR');
    });
  });

  // ── Empty upstream body must still reach the model as text ──────────

  describe('callTool with an empty upstream body', () => {
    let server: MerkMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should send a readable string, not a missing text key', async () => {
      // `JSON.stringify(undefined)` is `undefined`, which would drop the `text`
      // key entirely and leave the model with `{"content":[{"type":"text"}]}`.
      mockCompanyLookup.mockResolvedValue(undefined);

      const result = (await server.callTool('merk_company_lookup', {
        regno: '12345678',
      })) as { content: Array<{ text: string }>; isError?: boolean };

      expect(typeof result.content[0]?.text).toBe('string');
      expect(result.isError).toBeUndefined();
    });

    it('should tell the model an empty read is not an empty result set', async () => {
      mockCompanyEmployees.mockResolvedValue(undefined);

      const result = (await server.callTool('merk_company_employees', {
        regno: '12345678',
      })) as { content: Array<{ text: string }> };

      const data = JSON.parse(String(result.content[0]?.text));
      expect(data.success).toBe(false);
      expect(data.tool).toBe('merk_company_employees');
      expect(data.message).toContain('empty list');
    });

    it('should pass a genuine null answer through untouched', async () => {
      // The reason the client keeps `undefined` and `null` apart: `null` is a
      // valid JSON answer and must not be dressed up as an empty-body notice.
      mockCompanyLookup.mockResolvedValue(null);

      const result = (await server.callTool('merk_company_lookup', {
        regno: '12345678',
      })) as { content: Array<{ text: string }> };

      expect(result.content[0]?.text).toBe('null');
    });
  });

  // ── Error payloads: code in its own field, once ─────────────────────

  describe('error payload shape', () => {
    let server: MerkMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should not repeat the code inside the message', async () => {
      const { MerkApiError } = await import('../src/client.js');
      mockCompanyLookup.mockRejectedValue(new MerkApiError('boom', 400, 'BAD_REQUEST'));

      const result = (await server.callTool('merk_company_lookup', {
        regno: '12345678',
      })) as { content: Array<{ text: string }>; isError: boolean };

      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('BAD_REQUEST');
      expect(errorData.message).toBe('boom');
      expect(errorData.message).not.toContain('BAD_REQUEST:');
    });

    it('should surface FORBIDDEN separately from INVALID_API_KEY', async () => {
      const { MerkApiError } = await import('../src/client.js');
      mockCompanyLookup.mockRejectedValue(new MerkApiError('Forbidden', 403, 'FORBIDDEN'));

      const result = (await server.callTool('merk_company_lookup', {
        regno: '12345678',
      })) as { content: Array<{ text: string }>; isError: boolean };

      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('FORBIDDEN');
    });

    it('should relay the hint when the client supplies one', async () => {
      const { MerkApiError } = await import('../src/client.js');
      mockCompanyLookup.mockRejectedValue(
        new MerkApiError('Forbidden', 403, 'FORBIDDEN', 'Check merk_subscription_info.'),
      );

      const result = (await server.callTool('merk_company_lookup', {
        regno: '12345678',
      })) as { content: Array<{ text: string }> };

      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.hint).toBe('Check merk_subscription_info.');
    });

    it('should omit the hint key when there is none', async () => {
      const { MerkApiError } = await import('../src/client.js');
      mockCompanyLookup.mockRejectedValue(new MerkApiError('Server error', 500, 'API_ERROR'));

      const result = (await server.callTool('merk_company_lookup', {
        regno: '12345678',
      })) as { content: Array<{ text: string }> };

      const errorData = JSON.parse(String(result.content[0]?.text));
      expect('hint' in errorData).toBe(false);
    });
  });
});
