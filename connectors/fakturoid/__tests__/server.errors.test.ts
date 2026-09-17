/**
 * Unit tests for FakturoidMcpServer — callTool error handling, empty upstream
 * bodies and error code/message shape.
 *
 * Split out of the original server.test.ts; shared fixtures live in
 * server.helpers.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakturoidMcpServer } from '../src/server.js';
import {
  createInitializedServer,
  mockDeleteInvoice,
  mockDeletePayment,
  mockGetAccount,
  mockGetInvoice,
  mockListInvoices,
  mockListTags,
  resetMocks,
} from './server.helpers.js';

// Module mocks are hoisted per file, so this call cannot be shared through the
// helper - only the factory body it delegates to.
vi.mock('../src/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/client.js')>();
  const { mockClientModule } = await import('./server.helpers.js');
  return mockClientModule(original);
});

describe('FakturoidMcpServer', () => {
  beforeEach(() => {
    resetMocks();
  });

  // ── callTool - error handling ───────────────────────────────────────

  describe('callTool - error handling', () => {
    let server: FakturoidMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should return UNKNOWN_TOOL error for unknown tool name', async () => {
      const result = (await server.callTool('fakturoid_nonexistent', {})) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('UNKNOWN_TOOL');
    });

    it('should return INVALID_INPUT error with Zod issue details', async () => {
      const result = (await server.callTool('fakturoid_get_invoice', {
        id: 'not-a-number',
      })) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('INVALID_INPUT');
      expect(errorData.details).toBeDefined();
      expect(errorData.details.length).toBeGreaterThan(0);
      expect(errorData.details[0].path).toBe('id');
    });

    it('should return structured error when client throws FakturoidApiError', async () => {
      const { FakturoidApiError } = await import('../src/client.js');
      mockGetAccount.mockRejectedValue(new FakturoidApiError('Not found', 404, 'NOT_FOUND'));

      const result = (await server.callTool('fakturoid_get_account', {})) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('NOT_FOUND');
      expect(errorData.message).toContain('Not found');
    });

    it('should return API_ERROR when client throws generic Error', async () => {
      mockGetAccount.mockRejectedValue(new Error('Network failure'));

      const result = (await server.callTool('fakturoid_get_account', {})) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      const errorData = JSON.parse(String(result.content[0]?.text));
      expect(errorData.error).toBe('API_ERROR');
      expect(errorData.message).toBe('Network failure');
    });
  });

  // ── Empty upstream body ──────────────────────────────────────

  describe('callTool - empty response body', () => {
    let server: FakturoidMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should still produce a text block when a delete returns 204', async () => {
      // The assertion that was missing. `JSON.stringify(undefined)` is
      // `undefined`, so the `text` key dropped out of the content block and the
      // model received `{"content":[{"type":"text"}]}`. Checking only
      // `isError` was undefined let that through for both delete tools.
      mockDeleteInvoice.mockResolvedValue(undefined);

      const result = (await server.callTool('fakturoid_delete_invoice', { id: 1 })) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(typeof result.content[0]?.text).toBe('string');
    });

    it('should report an empty write body as an applied change', async () => {
      mockDeletePayment.mockResolvedValue(undefined);

      const result = (await server.callTool('fakturoid_delete_payment', {
        invoice_id: 1,
        payment_id: 2,
      })) as { content: Array<{ text: string }> };

      const data = JSON.parse(String(result.content[0]?.text));
      expect(data.success).toBe(true);
      expect(data.tool).toBe('fakturoid_delete_payment');
      expect(data.message).toBeTruthy();
    });

    it('should refuse to call an empty read body a success', async () => {
      // An empty body on a read is not "no records" — that would come back as
      // an empty list. Reporting success invites the model to tell the user the
      // account is empty.
      mockListInvoices.mockResolvedValue(undefined);

      const result = (await server.callTool('fakturoid_list_invoices', {})) as {
        content: Array<{ text: string }>;
      };

      const data = JSON.parse(String(result.content[0]?.text));
      expect(data.success).toBe(false);
      expect(data.tool).toBe('fakturoid_list_invoices');
      expect(data.message).toContain('does NOT mean there are no matching records');
    });

    it('should leave null alone rather than wrapping it', async () => {
      // null is valid JSON and a real answer; only undefined is the problem.
      mockGetInvoice.mockResolvedValue(null);

      const result = (await server.callTool('fakturoid_get_invoice', { id: 1 })) as {
        content: Array<{ text: string }>;
      };

      expect(result.content[0]?.text).toBe('null');
    });

    it('should leave an empty list alone', async () => {
      mockListTags.mockResolvedValue([]);

      const result = (await server.callTool('fakturoid_list_tags', {})) as {
        content: Array<{ text: string }>;
      };

      expect(result.content[0]?.text).toBe('[]');
    });
  });

  // ── Error code and message shape ─────────────────────────────

  describe('callTool - error shape', () => {
    let server: FakturoidMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should not repeat the code inside the message', async () => {
      // The code travels as its own field, so prefixing it
      // onto the message produced `"message":"BAD_REQUEST: ..."`.
      const { FakturoidApiError } = await import('../src/client.js');
      mockGetAccount.mockRejectedValue(new FakturoidApiError('boom', 400, 'BAD_REQUEST'));

      const result = (await server.callTool('fakturoid_get_account', {})) as {
        content: Array<{ text: string }>;
        isError: boolean;
      };

      const data = JSON.parse(String(result.content[0]?.text));
      expect(result.isError).toBe(true);
      expect(data.error).toBe('BAD_REQUEST');
      expect(data.message).toBe('boom');
      expect(data.message).not.toContain('BAD_REQUEST');
    });

    it('should report 401 and 403 as different codes', async () => {
      const { FakturoidApiError } = await import('../src/client.js');

      mockGetAccount.mockRejectedValueOnce(
        new FakturoidApiError('Unauthorized', 401, 'INVALID_API_KEY'),
      );
      const unauthorized = (await server.callTool('fakturoid_get_account', {})) as {
        content: Array<{ text: string }>;
      };

      mockGetAccount.mockRejectedValueOnce(new FakturoidApiError('Forbidden', 403, 'FORBIDDEN'));
      const forbidden = (await server.callTool('fakturoid_get_account', {})) as {
        content: Array<{ text: string }>;
      };

      expect(JSON.parse(String(unauthorized.content[0]?.text)).error).toBe('INVALID_API_KEY');
      expect(JSON.parse(String(forbidden.content[0]?.text)).error).toBe('FORBIDDEN');
    });

    it('should pass the hint through when the client supplies one', async () => {
      const { FakturoidApiError } = await import('../src/client.js');
      mockGetAccount.mockRejectedValue(
        new FakturoidApiError('Forbidden', 403, 'FORBIDDEN', 'The credentials are fine.'),
      );

      const result = (await server.callTool('fakturoid_get_account', {})) as {
        content: Array<{ text: string }>;
      };

      expect(JSON.parse(String(result.content[0]?.text)).hint).toBe('The credentials are fine.');
    });

    it('should omit the hint key entirely when there is none', async () => {
      const { FakturoidApiError } = await import('../src/client.js');
      mockGetAccount.mockRejectedValue(new FakturoidApiError('boom', 500, 'API_ERROR'));

      const result = (await server.callTool('fakturoid_get_account', {})) as {
        content: Array<{ text: string }>;
      };

      expect(JSON.parse(String(result.content[0]?.text))).not.toHaveProperty('hint');
    });
  });
});
