/**
 * Unit tests for FlexiMcpServer.
 *
 * Scope matches the sweep: the tool annotations, the empty-body payload
 * and the error payload shape. Coverage of all 30 tools' request
 * plumbing is deliberately out of scope — that lives in the client, and the
 * handlers here are one-line adapters.
 */

import type { ApiKeyConfig } from '@dxheroes/mcp-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlexiApiError } from '../src/client.js';
import { FlexiMcpServer } from '../src/server.js';

/** Every FlexiClient method the tool table reaches for. */
const CLIENT_METHODS = [
  'validateApiKey',
  'getAccountInfo',
  'listIssuedInvoices',
  'getIssuedInvoice',
  'createIssuedInvoice',
  'updateIssuedInvoice',
  'listReceivedInvoices',
  'getReceivedInvoice',
  'createReceivedInvoice',
  'updateReceivedInvoice',
  'listContacts',
  'getContact',
  'createContact',
  'updateContact',
  'listBankStatements',
  'listProducts',
  'createProduct',
  'updateProduct',
  'listOrdersReceived',
  'createOrderReceived',
  'listOrdersIssued',
  'createOrderIssued',
  'listCashMovements',
  'listInternalDocuments',
  'createInternalDocument',
  'listStockMovements',
  'listRecords',
  'getRecord',
  'createRecord',
  'updateRecord',
  'deleteRecord',
] as const;

const mocks = Object.fromEntries(CLIENT_METHODS.map((name) => [name, vi.fn()])) as Record<
  (typeof CLIENT_METHODS)[number],
  ReturnType<typeof vi.fn>
>;

// `importOriginal` matters: the real FlexiApiError must reach the server, or
// the `instanceof` in `handleApiError` fails and the coded-error assertions below
// would be testing the generic fallback instead of the branch they name.
vi.mock('../src/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/client.js')>();
  return {
    ...original,
    FlexiClient: class MockFlexiClient {
      constructor() {
        Object.assign(this, mocks);
      }
    },
  };
});

const apiKeyConfig: ApiKeyConfig = {
  apiKey: 'https://203.0.113.10/c/demo|admin:secret',
  headerName: 'Authorization',
  headerValue: 'Basic {apiKey}',
};

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

/** The JSON the model actually receives, or a failure if `text` went missing. */
function payloadOf(result: ToolResult): unknown {
  const text = result.content[0]?.text;
  // Without this assertion the empty-body bug is invisible, because
  // `JSON.parse(undefined as never)` and `?? '{}'` both paper over it.
  expect(typeof text).toBe('string');
  return JSON.parse(text as string);
}

async function newServer(): Promise<FlexiMcpServer> {
  const server = new FlexiMcpServer(apiKeyConfig);
  await server.initialize();
  return server;
}

describe('FlexiMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── MCP annotations (the operator's only lever) ──────────────────────

  describe('tool annotations', () => {
    it('should expose exactly 30 tools', async () => {
      const tools = await (await newServer()).listTools();
      expect(tools.length).toBe(30);
    });

    it('should annotate every tool, so none defaults into the write group', async () => {
      // The connector host classifies purely on `annotations.readOnlyHint`; a tool
      // with no annotations is treated as a write, so all 16 read-only tools
      // used to land in the group an operator would gate behind approval.
      const tools = await (await newServer()).listTools();
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toBeDefined();
        expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      }
    });

    it('should mark the read-only tools read-only', async () => {
      const tools = await (await newServer()).listTools();
      const readOnly = [
        'flexi_get_account_info',
        'flexi_list_issued_invoices',
        'flexi_get_issued_invoice',
        'flexi_list_received_invoices',
        'flexi_get_received_invoice',
        'flexi_list_contacts',
        'flexi_get_contact',
        'flexi_list_bank_statements',
        'flexi_list_products',
        'flexi_list_orders_received',
        'flexi_list_orders_issued',
        'flexi_list_cash_movements',
        'flexi_list_internal_documents',
        'flexi_list_stock_movements',
        'flexi_list_records',
        'flexi_get_record',
      ];
      for (const name of readOnly) {
        expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint, name).toBe(true);
      }
      // Pinned, not floored: a write tool that claimed to be read-only would
      // be waved straight through the connector host's classification.
      const readOnlyCount = tools.filter((t) => t.annotations?.readOnlyHint === true).length;
      expect(readOnlyCount).toBe(readOnly.length);
    });

    it('should partition the 30 tools into 16 read-only, 8 additive writes, 6 destructive', async () => {
      // Pinning all three groups by exact count — not a floor — means a tool
      // cannot change group without a test saying so. A floor of 4 against an
      // actual 6 would let two updates quietly lose the annotation, which is
      // the failure this block exists to catch.
      const tools = await (await newServer()).listTools();
      const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true);
      const additiveWrites = tools.filter(
        (t) => t.annotations?.readOnlyHint === false && t.annotations?.destructiveHint === false,
      );
      const destructive = tools.filter((t) => t.annotations?.destructiveHint === true);
      expect(readOnly.length).toBe(16);
      expect(additiveWrites.length).toBe(8);
      expect(destructive.length).toBe(6);
      expect(readOnly.length + additiveWrites.length + destructive.length).toBe(30);
    });

    it('should say DESTRUCTIVE in the description of every destructive tool', async () => {
      // Checked against the annotations, not the tool names: an overwrite is
      // destructive without being called `_delete_`, and a guard keyed on the
      // name is exactly how the update family kept an "adds only" annotation
      // while replacing values that cannot be read back.
      const tools = await (await newServer()).listTools();
      const destructive = tools.filter((t) => t.annotations?.destructiveHint === true);
      expect(destructive.length).toBe(6);
      for (const tool of destructive) {
        expect(tool.description, tool.name).toContain('DESTRUCTIVE');
      }
    });

    it('should annotate the whole update family, not just the delete', async () => {
      // Per the MCP definition ("not purely additive"), not per the tool name.
      // A Flexi PUT changes only the fields it is given, but each one replaces
      // its previous value and the REST API cannot read the old value back.
      const tools = await (await newServer()).listTools();
      const updates = tools.filter((t) => t.name.includes('_update_'));
      expect(updates.length).toBe(5);
      for (const tool of updates) {
        expect(tool.annotations?.destructiveHint, tool.name).toBe(true);
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
      }
    });

    it('should mark flexi_delete_record destructive and not read-only', async () => {
      const tools = await (await newServer()).listTools();
      const del = tools.find((t) => t.name === 'flexi_delete_record');
      expect(del?.annotations?.readOnlyHint).toBe(false);
      expect(del?.annotations?.destructiveHint).toBe(true);
    });

    it('should not mark a purely additive create as destructive', async () => {
      const tools = await (await newServer()).listTools();
      for (const name of ['flexi_create_contact', 'flexi_create_record', 'flexi_create_product']) {
        expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint, name).toBe(false);
        expect(tools.find((t) => t.name === name)?.annotations?.destructiveHint, name).toBe(false);
      }
    });

    it('should never mark a destructive tool read-only', async () => {
      const tools = await (await newServer()).listTools();
      for (const tool of tools.filter((t) => t.annotations?.destructiveHint === true)) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
      }
    });

    it('should warn that the generic tools act on whatever evidence is passed', async () => {
      // One annotation covers deleting an invoice, a contact or an accounting
      // document, so the description must not promise anything about a
      // specific evidence.
      const tools = await (await newServer()).listTools();
      for (const name of ['flexi_delete_record', 'flexi_update_record']) {
        expect(tools.find((t) => t.name === name)?.description, name).toMatch(/ANY Flexi evidence/);
      }
    });
  });

  // ── An empty upstream body must still produce readable text ──────────

  describe('empty response bodies', () => {
    it('should return readable text when a delete answers with an empty body', async () => {
      // Flexi answers DELETE with an empty 200 and the client surfaces that as
      // `undefined`. `JSON.stringify(undefined)` is `undefined`, so the `text`
      // key used to vanish and the model got {"content":[{"type":"text"}]}.
      mocks.deleteRecord.mockResolvedValue(undefined);
      const result = (await (
        await newServer()
      ).callTool('flexi_delete_record', { evidence: 'adresar', id: 7 })) as ToolResult;
      expect(result.isError).toBeUndefined();
      expect(payloadOf(result)).toMatchObject({ success: true, tool: 'flexi_delete_record' });
    });

    it('should call an empty body on a write a success', async () => {
      mocks.updateContact.mockResolvedValue(undefined);
      const result = (await (
        await newServer()
      ).callTool('flexi_update_contact', { id: 3, nazev: 'Acme' })) as ToolResult;
      expect(payloadOf(result)).toMatchObject({ success: true });
    });

    it('should NOT call an empty body on a read a success', async () => {
      // The read branch is the one that matters: an empty body is not "no
      // records" — an empty evidence comes back as an empty list inside the
      // winstrom envelope — and reporting success invites the model to tell
      // the user the address book is empty.
      mocks.listContacts.mockResolvedValue(undefined);
      const result = (await (await newServer()).callTool('flexi_list_contacts', {})) as ToolResult;
      const payload = payloadOf(result) as { success: boolean; message: string };
      expect(payload.success).toBe(false);
      expect(payload.message).toMatch(/does NOT mean there are no records/);
    });

    it('should pass null through untouched', async () => {
      // Valid JSON and a real answer; only `undefined` is the broken case.
      mocks.getContact.mockResolvedValue(null);
      const result = (await (
        await newServer()
      ).callTool('flexi_get_contact', { id: 1 })) as ToolResult;
      expect(payloadOf(result)).toBeNull();
    });

    it('should pass a normal result through unchanged', async () => {
      mocks.listContacts.mockResolvedValue({ adresar: [{ id: '1' }] });
      const result = (await (await newServer()).callTool('flexi_list_contacts', {})) as ToolResult;
      expect(payloadOf(result)).toEqual({ adresar: [{ id: '1' }] });
    });
  });

  // ── Error payload ────────────────────────────────────────────────────

  describe('error payloads', () => {
    it('should report the code once, in its own field', async () => {
      // Used to be {"error":"BAD_REQUEST","message":"BAD_REQUEST: Chybny filtr"}.
      mocks.listContacts.mockRejectedValue(new FlexiApiError('Chybny filtr', 400, 'BAD_REQUEST'));
      const result = (await (await newServer()).callTool('flexi_list_contacts', {})) as ToolResult;
      expect(result.isError).toBe(true);
      const payload = payloadOf(result) as { error: string; message: string };
      expect(payload).toEqual({ error: 'BAD_REQUEST', message: 'Chybny filtr' });
      expect(payload.message).not.toContain('BAD_REQUEST:');
    });

    it('should keep 401 and 403 apart in what the model is told', async () => {
      const server = await newServer();

      mocks.listContacts.mockRejectedValueOnce(
        new FlexiApiError('Neplatne prihlaseni', 401, 'INVALID_API_KEY', 'check the key'),
      );
      const unauthorized = payloadOf(
        (await server.callTool('flexi_list_contacts', {})) as ToolResult,
      ) as { error: string };

      mocks.listContacts.mockRejectedValueOnce(
        new FlexiApiError('Nedostatecna prava', 403, 'FORBIDDEN', 'check the rights'),
      );
      const forbidden = payloadOf(
        (await server.callTool('flexi_list_contacts', {})) as ToolResult,
      ) as { error: string };

      expect(unauthorized.error).toBe('INVALID_API_KEY');
      expect(forbidden.error).toBe('FORBIDDEN');
      expect(unauthorized.error).not.toBe(forbidden.error);
    });

    it('should pass the hint on to the caller when there is one', async () => {
      mocks.listContacts.mockRejectedValue(
        new FlexiApiError('Nelicencovano', 402, 'PAYMENT_REQUIRED', 'write access is licensed'),
      );
      const result = (await (await newServer()).callTool('flexi_list_contacts', {})) as ToolResult;
      expect(payloadOf(result)).toEqual({
        error: 'PAYMENT_REQUIRED',
        message: 'Nelicencovano',
        hint: 'write access is licensed',
      });
    });

    it('should omit the hint key when there is none', async () => {
      mocks.listContacts.mockRejectedValue(new FlexiApiError('Rozbito', 500, 'API_ERROR'));
      const result = (await (await newServer()).callTool('flexi_list_contacts', {})) as ToolResult;
      expect(payloadOf(result)).toEqual({ error: 'API_ERROR', message: 'Rozbito' });
    });

    it('should fall back to API_ERROR for a non-Flexi failure', async () => {
      mocks.listContacts.mockRejectedValue(new Error('socket hang up'));
      const result = (await (await newServer()).callTool('flexi_list_contacts', {})) as ToolResult;
      expect(payloadOf(result)).toEqual({ error: 'API_ERROR', message: 'socket hang up' });
    });
  });

  // ── Dispatch guards ──────────────────────────────────────────────────

  describe('callTool', () => {
    it('should report a missing API key instead of throwing', async () => {
      const server = new FlexiMcpServer(null);
      await server.initialize();
      const result = (await server.callTool('flexi_list_contacts', {})) as ToolResult;
      expect(result.isError).toBe(true);
      expect((payloadOf(result) as { error: string }).error).toBe('API_KEY_REQUIRED');
    });

    it('should report an unknown tool', async () => {
      const result = (await (await newServer()).callTool('flexi_nope', {})) as ToolResult;
      expect((payloadOf(result) as { error: string }).error).toBe('UNKNOWN_TOOL');
    });

    it('should reject input that fails the schema before calling the client', async () => {
      const result = (await (
        await newServer()
      ).callTool('flexi_delete_record', { evidence: 'adresar' })) as ToolResult;
      expect(result.isError).toBe(true);
      expect((payloadOf(result) as { error: string }).error).toBe('INVALID_INPUT');
      expect(mocks.deleteRecord).not.toHaveBeenCalled();
    });

    it('should hand the parsed arguments to the client', async () => {
      mocks.updateRecord.mockResolvedValue({ ok: true });
      await (await newServer()).callTool('flexi_update_record', {
        evidence: 'faktura-vydana',
        id: 12,
        data: { poznam: 'x' },
      });
      expect(mocks.updateRecord).toHaveBeenCalledWith('faktura-vydana', 12, { poznam: 'x' });
    });
  });

  // ── validate() ───────────────────────────────────────────────────────

  describe('validate', () => {
    it('should report a missing API key', async () => {
      await expect(new FlexiMcpServer(null).validate()).resolves.toEqual({
        valid: false,
        error: 'API key not configured',
      });
    });

    it('should delegate to the client', async () => {
      mocks.validateApiKey.mockResolvedValue({ valid: true });
      await expect(new FlexiMcpServer(apiKeyConfig).validate()).resolves.toEqual({ valid: true });
    });
  });
});
