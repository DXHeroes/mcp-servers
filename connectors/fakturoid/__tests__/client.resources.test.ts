/**
 * Unit tests for FakturoidClient — the remaining resource endpoints:
 * subjects, expenses, inventory, generators, events, todos and tags.
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

  // ── Subjects ─────────────────────────────────────────────────────────

  describe('listSubjects', () => {
    it('GET with page param', async () => {
      mockTokenAndResponse([]);
      await client.listSubjects({ page: 1 });
      const callUrl = mockFetch.mock.calls[1]?.[0];
      expect(callUrl).toContain(url('subjects.json'));
      expect(callUrl).toContain('page=1');
    });
  });

  describe('getSubject', () => {
    it('GET subjects/{id}.json', async () => {
      mockTokenAndResponse({ id: 5 });
      await client.getSubject({ id: 5 });
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('subjects/5.json'));
    });
  });

  describe('createSubject', () => {
    it('POST with body', async () => {
      const data = { name: 'Acme Corp' };
      mockTokenAndResponse({ id: 5 });
      await client.createSubject(data);
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toBe(url('subjects.json'));
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual(data);
    });
  });

  describe('searchSubjects', () => {
    it('GET search.json with query', async () => {
      mockTokenAndResponse([]);
      await client.searchSubjects({ query: 'acme' });
      const callUrl = mockFetch.mock.calls[1]?.[0];
      expect(callUrl).toContain(url('subjects/search.json'));
      expect(callUrl).toContain('query=acme');
    });
  });

  describe('updateSubject', () => {
    it('PATCH with body', async () => {
      mockTokenAndResponse({ id: 5 });
      await client.updateSubject({ id: 5 }, { name: 'Acme Inc' });
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toBe(url('subjects/5.json'));
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body)).toEqual({ name: 'Acme Inc' });
    });
  });

  describe('deleteSubject', () => {
    it('DELETE subjects/{id}.json', async () => {
      mockTokenAndResponse(undefined, 204);
      await client.deleteSubject({ id: 5 });
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('subjects/5.json'));
      expect(mockFetch.mock.calls[1]?.[1].method).toBe('DELETE');
    });
  });

  // ── Expenses ─────────────────────────────────────────────────────────

  describe('listExpenses', () => {
    it('GET with status param', async () => {
      mockTokenAndResponse([]);
      await client.listExpenses({ status: 'open' });
      const callUrl = mockFetch.mock.calls[1]?.[0];
      expect(callUrl).toContain(url('expenses.json'));
      expect(callUrl).toContain('status=open');
    });
  });

  describe('createExpense', () => {
    it('POST with body', async () => {
      const data = { subject_id: 5, total: 1000 };
      mockTokenAndResponse({ id: 10 });
      await client.createExpense(data);
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toBe(url('expenses.json'));
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual(data);
    });
  });

  describe('getExpense', () => {
    it('GET expenses/{id}.json', async () => {
      mockTokenAndResponse({ id: 10 });
      await client.getExpense({ id: 10 });
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('expenses/10.json'));
    });
  });

  describe('updateExpense', () => {
    it('PATCH with body', async () => {
      mockTokenAndResponse({ id: 10 });
      await client.updateExpense({ id: 10 }, { note: 'updated' });
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toBe(url('expenses/10.json'));
      expect(init.method).toBe('PATCH');
    });
  });

  describe('searchExpenses', () => {
    it('GET search.json with query', async () => {
      mockTokenAndResponse([]);
      await client.searchExpenses({ query: 'office' });
      const callUrl = mockFetch.mock.calls[1]?.[0];
      expect(callUrl).toContain(url('expenses/search.json'));
      expect(callUrl).toContain('query=office');
    });
  });

  // ── Expense Payments ─────────────────────────────────────────────────

  describe('createExpensePayment', () => {
    it('POST with amount in body', async () => {
      mockTokenAndResponse({ id: 1 });
      await client.createExpensePayment({ id: 10, amount: 500 });
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toBe(url('expenses/10/payments.json'));
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ amount: 500 });
    });
  });

  describe('deleteExpensePayment', () => {
    it('DELETE expense payment', async () => {
      mockTokenAndResponse(undefined, 204);
      await client.deleteExpensePayment({ expense_id: 10, payment_id: 20 });
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('expenses/10/payments/20.json'));
      expect(mockFetch.mock.calls[1]?.[1].method).toBe('DELETE');
    });
  });

  // ── Inventory Items ──────────────────────────────────────────────────

  describe('listInventoryItems', () => {
    it('GET with page param', async () => {
      mockTokenAndResponse([]);
      await client.listInventoryItems({ page: 1 });
      const callUrl = mockFetch.mock.calls[1]?.[0];
      expect(callUrl).toContain(url('inventory_items.json'));
      expect(callUrl).toContain('page=1');
    });
  });

  describe('getInventoryItem', () => {
    it('GET inventory_items/{id}.json', async () => {
      mockTokenAndResponse({ id: 7 });
      await client.getInventoryItem({ id: 7 });
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('inventory_items/7.json'));
    });
  });

  describe('createInventoryItem', () => {
    it('POST with body', async () => {
      const data = { name: 'Widget', article_number: 'W-001' };
      mockTokenAndResponse({ id: 7 });
      await client.createInventoryItem(data);
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toBe(url('inventory_items.json'));
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual(data);
    });
  });

  describe('updateInventoryItem', () => {
    it('PATCH with body', async () => {
      mockTokenAndResponse({ id: 7 });
      await client.updateInventoryItem({ id: 7 }, { name: 'Updated Widget' });
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toBe(url('inventory_items/7.json'));
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body)).toEqual({ name: 'Updated Widget' });
    });
  });

  describe('searchInventoryItems', () => {
    it('GET search.json with query', async () => {
      mockTokenAndResponse([]);
      await client.searchInventoryItems({ query: 'widget' });
      const callUrl = mockFetch.mock.calls[1]?.[0];
      expect(callUrl).toContain(url('inventory_items/search.json'));
      expect(callUrl).toContain('query=widget');
    });
  });

  // ── Inventory Moves ──────────────────────────────────────────────────

  describe('listInventoryMoves', () => {
    it('GET with inventory_item_id param', async () => {
      mockTokenAndResponse([]);
      await client.listInventoryMoves({ inventory_item_id: 7 });
      const callUrl = mockFetch.mock.calls[1]?.[0];
      expect(callUrl).toContain(url('inventory_moves.json'));
      expect(callUrl).toContain('inventory_item_id=7');
    });
  });

  describe('createInventoryMove', () => {
    it('POST to inventory_items/{id}/inventory_moves.json', async () => {
      mockTokenAndResponse({ id: 1 });
      await client.createInventoryMove({
        inventory_item_id: 7,
        direction: 'in',
        quantity: 10,
      });
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toBe(url('inventory_items/7/inventory_moves.json'));
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ direction: 'in', quantity: 10 });
    });
  });

  // ── Generators ───────────────────────────────────────────────────────

  describe('listGenerators', () => {
    it('GET generators.json', async () => {
      mockTokenAndResponse([]);
      await client.listGenerators({});
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('generators.json'));
    });
  });

  describe('getGenerator', () => {
    it('GET generators/{id}.json', async () => {
      mockTokenAndResponse({ id: 3 });
      await client.getGenerator({ id: 3 });
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('generators/3.json'));
    });
  });

  describe('createGenerator', () => {
    it('POST generators.json', async () => {
      const data = { name: 'Monthly Invoice' };
      mockTokenAndResponse({ id: 3 });
      await client.createGenerator(data);
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toBe(url('generators.json'));
      expect(init.method).toBe('POST');
    });
  });

  // ── Recurring Generators ─────────────────────────────────────────────

  describe('listRecurringGenerators', () => {
    it('GET recurring_generators.json', async () => {
      mockTokenAndResponse([]);
      await client.listRecurringGenerators({});
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('recurring_generators.json'));
    });
  });

  describe('getRecurringGenerator', () => {
    it('GET recurring_generators/{id}.json', async () => {
      mockTokenAndResponse({ id: 4 });
      await client.getRecurringGenerator({ id: 4 });
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('recurring_generators/4.json'));
    });
  });

  // ── Events & Todos ───────────────────────────────────────────────────

  describe('listEvents', () => {
    it('GET events.json with subject_id param', async () => {
      mockTokenAndResponse([]);
      await client.listEvents({ subject_id: 5 });
      const callUrl = mockFetch.mock.calls[1]?.[0];
      expect(callUrl).toContain(url('events.json'));
      expect(callUrl).toContain('subject_id=5');
    });
  });

  describe('listTodos', () => {
    it('GET todos.json', async () => {
      mockTokenAndResponse([]);
      await client.listTodos({});
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('todos.json'));
    });
  });

  describe('toggleTodo', () => {
    it('POST todos/{id}/toggle_completion.json', async () => {
      mockTokenAndResponse({});
      await client.toggleTodo({ id: 1 });
      const [callUrl, init] = mockFetch.mock.calls[1] ?? [];
      expect(callUrl).toBe(url('todos/1/toggle_completion.json'));
      expect(init.method).toBe('POST');
    });
  });

  describe('listTags', () => {
    it('GET tags.json', async () => {
      mockTokenAndResponse([]);
      await client.listTags();
      expect(mockFetch.mock.calls[1]?.[0]).toBe(url('tags.json'));
    });
  });
});
