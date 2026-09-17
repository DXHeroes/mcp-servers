/**
 * Unit tests for FakturoidClient — account endpoints and the invoice family
 * (invoices, invoice payments, invoice messages).
 *
 * Tests mock global.fetch to verify HTTP requests are constructed correctly.
 * Every API call requires TWO fetches: token exchange + actual request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakturoidClient } from '../src/client.js';
import {
  createTestClient,
  mockFetch,
  mockTokenAndResponse,
  restoreGlobals,
  url,
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

  // ── Account ──────────────────────────────────────────────────────────

  describe('getAccount', () => {
    it('GET accounts/{slug}/account.json', async () => {
      mockTokenAndResponse({ name: 'Test' });
      const result = await client.getAccount();
      expect(result).toEqual({ name: 'Test' });
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('account.json'));
      expect(mockFetch.mock.calls[1]?.[1].method).toBe('GET');
    });
  });

  describe('listUsers', () => {
    it('GET accounts/{slug}/users.json', async () => {
      mockTokenAndResponse([{ id: 1 }]);
      await client.listUsers();
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('users.json'));
    });
  });

  describe('listBankAccounts', () => {
    it('GET accounts/{slug}/bank_accounts.json', async () => {
      mockTokenAndResponse([{ id: 1 }]);
      await client.listBankAccounts();
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('bank_accounts.json'));
    });
  });

  // ── Invoices ─────────────────────────────────────────────────────────

  describe('listInvoices', () => {
    it('GET with query params', async () => {
      mockTokenAndResponse([]);
      await client.listInvoices({ page: 2, status: 'paid' });
      const callUrl = mockFetch.mock.calls[1]?.[0];
      expect(callUrl).toContain(url('invoices.json'));
      expect(callUrl).toContain('page=2');
      expect(callUrl).toContain('status=paid');
    });
  });

  describe('getInvoice', () => {
    it('GET accounts/{slug}/invoices/{id}.json', async () => {
      mockTokenAndResponse({ id: 123 });
      await client.getInvoice({ id: 123 });
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('invoices/123.json'));
    });
  });

  describe('createInvoice', () => {
    it('POST with body', async () => {
      const data = { subject_id: 5, lines: [] };
      mockTokenAndResponse({ id: 1 });
      await client.createInvoice(data);
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toBe(url('invoices.json'));
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual(data);
    });
  });

  describe('updateInvoice', () => {
    it('PATCH with body', async () => {
      mockTokenAndResponse({ id: 123 });
      await client.updateInvoice({ id: 123 }, { note: 'updated' });
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toBe(url('invoices/123.json'));
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body)).toEqual({ note: 'updated' });
    });
  });

  describe('invoiceAction', () => {
    it('POST fire.json with event query param', async () => {
      mockTokenAndResponse(undefined, 204);
      await client.invoiceAction({ id: 123, event: 'pay' });
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toContain(url('invoices/123/fire.json'));
      expect(callUrl).toContain('event=pay');
      expect(init.method).toBe('POST');
    });
  });

  describe('searchInvoices', () => {
    it('GET search.json with query param', async () => {
      mockTokenAndResponse([]);
      await client.searchInvoices({ query: 'test' });
      const callUrl = mockFetch.mock.calls[1]?.[0];
      expect(callUrl).toContain(url('invoices/search.json'));
      expect(callUrl).toContain('query=test');
    });
  });

  describe('deleteInvoice', () => {
    it('DELETE returns undefined', async () => {
      mockTokenAndResponse(undefined, 204);
      const result = await client.deleteInvoice({ id: 123 });
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('invoices/123.json'));
      expect(mockFetch.mock.calls[1]?.[1].method).toBe('DELETE');
      expect(result).toBeUndefined();
    });
  });

  // ── Invoice Payments ─────────────────────────────────────────────────

  describe('createPayment', () => {
    it('POST with amount in body', async () => {
      mockTokenAndResponse({ id: 1 });
      await client.createPayment({ id: 123, amount: 1000 });
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toBe(url('invoices/123/payments.json'));
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ amount: 1000 });
    });
  });

  describe('deletePayment', () => {
    it('DELETE invoice payment', async () => {
      mockTokenAndResponse(undefined, 204);
      await client.deletePayment({ invoice_id: 123, payment_id: 456 });
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('invoices/123/payments/456.json'));
      expect(mockFetch.mock.calls[1]?.[1].method).toBe('DELETE');
    });
  });

  // ── Invoice Messages ─────────────────────────────────────────────────

  describe('sendInvoiceMessage', () => {
    it('POST with email in body', async () => {
      mockTokenAndResponse({});
      await client.sendInvoiceMessage({ id: 123, email: 'test@test.com' });
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toBe(url('invoices/123/message.json'));
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ email: 'test@test.com' });
    });
  });
});
