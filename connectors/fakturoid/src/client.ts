/**
 * Fakturoid API v3 client — thin HTTP wrapper around fetch
 *
 * Auth: OAuth 2.0 Client Credentials flow
 * API: https://app.fakturoid.cz/api/v3/accounts/{slug}/
 * Docs: https://www.fakturoid.cz/api/v3
 * Rate limit: tracked via X-RateLimit-* headers
 *
 * The error taxonomy lives in `client-errors.ts` and the stateless transport
 * helpers in `client-http.ts`. Both are re-exported here, so this module stays
 * the single import path for everything the client exposes.
 */

import { safeFetch } from '@dxheroes/mcp-kit';
import { FakturoidApiError, hintForCode, mapStatusToCode } from './client-errors.js';
import {
  buildAccountUrl,
  parseApiKey,
  readErrorMessage,
  requestAccessToken,
} from './client-http.js';

export { FakturoidApiError, type FakturoidErrorCode } from './client-errors.js';

export class FakturoidClient {
  private readonly slug: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private readonly userAgent: string;

  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(
    apiKey: string,
    baseUrl = 'https://app.fakturoid.cz/api/v3',
    userAgent = 'LocalMcpGateway (support@dxheroes.io)',
  ) {
    const { slug, clientId, clientSecret } = parseApiKey(apiKey);

    this.slug = slug;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.baseUrl = baseUrl;
    this.userAgent = userAgent;
  }

  // ── OAuth Token Exchange ───────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.cachedToken;
    }

    const data = await requestAccessToken({
      baseUrl: this.baseUrl,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      userAgent: this.userAgent,
    });
    this.cachedToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;

    return this.cachedToken;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
  ): Promise<T> {
    const url = buildAccountUrl(this.baseUrl, this.slug, path, params);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.getAccessToken()}`,
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    };
    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await safeFetch(url, { ...init, allowPrivate: true });

    // Handle 204 No Content (DELETE, fire.json POST, etc.)
    if (response.status === 204) {
      return undefined as T;
    }

    if (!response.ok) {
      const code = mapStatusToCode(response.status);
      const message = await readErrorMessage(response);
      throw new FakturoidApiError(message, response.status, code, hintForCode(code));
    }

    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  // ── Validation ───────────────────────────────────────────────────────

  async validateApiKey(): Promise<{ valid: boolean; error?: string }> {
    try {
      await this.request('GET', 'account.json');
      return { valid: true };
    } catch (error) {
      // On `account.json` a 403 still means the credentials are not usable.
      // Elsewhere FORBIDDEN is a business rule (locked document, subject limit)
      // and says nothing about the token, but there is no business rule that
      // can forbid reading your own account — reaching it is the whole point of
      // this call, so a refusal here is a credential or slug problem. Splitting
      // 403 off from INVALID_API_KEY would otherwise have quietly turned a
      // rejected key into "valid".
      if (
        error instanceof FakturoidApiError &&
        (error.code === 'INVALID_API_KEY' || error.code === 'FORBIDDEN')
      ) {
        return { valid: false, error: 'Invalid OAuth credentials or account slug' };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { valid: false, error: `Validation failed: ${message}` };
    }
  }

  // ── Account ──────────────────────────────────────────────────────────

  async getAccount(): Promise<unknown> {
    return this.request('GET', 'account.json');
  }

  // ── Users & Bank Accounts ───────────────────────────────────────────

  async listUsers(): Promise<unknown> {
    return this.request('GET', 'users.json');
  }

  async listBankAccounts(): Promise<unknown> {
    return this.request('GET', 'bank_accounts.json');
  }

  // ── Invoices ─────────────────────────────────────────────────────────

  async listInvoices(params: {
    page?: number;
    since?: string;
    updated_since?: string;
    until?: string;
    updated_until?: string;
    number?: string;
    status?: string;
    subject_id?: number;
    custom_id?: string;
    document_type?: string;
  }): Promise<unknown> {
    return this.request(
      'GET',
      'invoices.json',
      params as Record<string, string | number | undefined>,
    );
  }

  async getInvoice(params: { id: number }): Promise<unknown> {
    return this.request('GET', `invoices/${params.id}.json`);
  }

  async createInvoice(data: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', 'invoices.json', undefined, data);
  }

  async updateInvoice(params: { id: number }, data: Record<string, unknown>): Promise<unknown> {
    return this.request('PATCH', `invoices/${params.id}.json`, undefined, data);
  }

  async invoiceAction(params: {
    id: number;
    event: string;
    paid_on?: string;
    paid_amount?: number;
  }): Promise<unknown> {
    const { id, event, ...body } = params;
    return this.request('POST', `invoices/${id}/fire.json`, { event }, body);
  }

  async searchInvoices(params: { query: string; page?: number }): Promise<unknown> {
    const { query, ...rest } = params;
    return this.request('GET', 'invoices/search.json', {
      query,
      ...rest,
    } as Record<string, string | number | undefined>);
  }

  async deleteInvoice(params: { id: number }): Promise<unknown> {
    return this.request('DELETE', `invoices/${params.id}.json`);
  }

  // ── Invoice Payments ───────────────────────────────────────────────

  async createPayment(params: {
    id: number;
    paid_on?: string;
    amount?: number;
    currency?: string;
    bank_account_id?: number;
  }): Promise<unknown> {
    const { id, ...body } = params;
    return this.request('POST', `invoices/${id}/payments.json`, undefined, body);
  }

  async deletePayment(params: { invoice_id: number; payment_id: number }): Promise<unknown> {
    return this.request(
      'DELETE',
      `invoices/${params.invoice_id}/payments/${params.payment_id}.json`,
    );
  }

  // ── Invoice Messages ───────────────────────────────────────────────

  async sendInvoiceMessage(params: {
    id: number;
    email: string;
    subject?: string;
    message?: string;
  }): Promise<unknown> {
    const { id, ...body } = params;
    return this.request('POST', `invoices/${id}/message.json`, undefined, body);
  }

  // ── Subjects (Contacts) ─────────────────────────────────────────────

  async listSubjects(params: {
    page?: number;
    since?: string;
    updated_since?: string;
    custom_id?: string;
  }): Promise<unknown> {
    return this.request(
      'GET',
      'subjects.json',
      params as Record<string, string | number | undefined>,
    );
  }

  async getSubject(params: { id: number }): Promise<unknown> {
    return this.request('GET', `subjects/${params.id}.json`);
  }

  async createSubject(data: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', 'subjects.json', undefined, data);
  }

  async searchSubjects(params: { query: string; page?: number }): Promise<unknown> {
    return this.request('GET', 'subjects/search.json', params as Record<string, string | number>);
  }

  async updateSubject(params: { id: number }, data: Record<string, unknown>): Promise<unknown> {
    return this.request('PATCH', `subjects/${params.id}.json`, undefined, data);
  }

  async deleteSubject(params: { id: number }): Promise<unknown> {
    return this.request('DELETE', `subjects/${params.id}.json`);
  }

  // ── Expenses ─────────────────────────────────────────────────────────

  async listExpenses(params: {
    page?: number;
    since?: string;
    updated_since?: string;
    status?: string;
    subject_id?: number;
    number?: string;
    variable_symbol?: string;
    custom_id?: string;
  }): Promise<unknown> {
    return this.request(
      'GET',
      'expenses.json',
      params as Record<string, string | number | undefined>,
    );
  }

  async createExpense(data: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', 'expenses.json', undefined, data);
  }

  async getExpense(params: { id: number }): Promise<unknown> {
    return this.request('GET', `expenses/${params.id}.json`);
  }

  async updateExpense(params: { id: number }, data: Record<string, unknown>): Promise<unknown> {
    return this.request('PATCH', `expenses/${params.id}.json`, undefined, data);
  }

  async searchExpenses(params: { query: string; page?: number }): Promise<unknown> {
    return this.request('GET', 'expenses/search.json', params as Record<string, string | number>);
  }

  async deleteExpense(params: { id: number }): Promise<unknown> {
    return this.request('DELETE', `expenses/${params.id}.json`);
  }

  async expenseAction(params: { id: number; event: string }): Promise<unknown> {
    const { id, event } = params;
    return this.request('POST', `expenses/${id}/fire.json`, { event });
  }

  // ── Expense Payments ───────────────────────────────────────────────

  async createExpensePayment(params: {
    id: number;
    paid_on?: string;
    amount?: number;
    currency?: string;
  }): Promise<unknown> {
    const { id, ...body } = params;
    return this.request('POST', `expenses/${id}/payments.json`, undefined, body);
  }

  async deleteExpensePayment(params: { expense_id: number; payment_id: number }): Promise<unknown> {
    return this.request(
      'DELETE',
      `expenses/${params.expense_id}/payments/${params.payment_id}.json`,
    );
  }

  // ── Inventory Items ────────────────────────────────────────────────

  async listInventoryItems(params: { page?: number }): Promise<unknown> {
    return this.request(
      'GET',
      'inventory_items.json',
      params as Record<string, string | number | undefined>,
    );
  }

  async getInventoryItem(params: { id: number }): Promise<unknown> {
    return this.request('GET', `inventory_items/${params.id}.json`);
  }

  async createInventoryItem(data: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', 'inventory_items.json', undefined, data);
  }

  async updateInventoryItem(
    params: { id: number },
    data: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request('PATCH', `inventory_items/${params.id}.json`, undefined, data);
  }

  async searchInventoryItems(params: { query: string; page?: number }): Promise<unknown> {
    return this.request(
      'GET',
      'inventory_items/search.json',
      params as Record<string, string | number>,
    );
  }

  // ── Inventory Moves ────────────────────────────────────────────────

  async listInventoryMoves(params: {
    page?: number;
    since?: string;
    inventory_item_id?: number;
  }): Promise<unknown> {
    return this.request(
      'GET',
      'inventory_moves.json',
      params as Record<string, string | number | undefined>,
    );
  }

  async createInventoryMove(params: {
    inventory_item_id: number;
    direction: string;
    quantity: number;
    price_per_unit?: number;
    moved_on?: string;
  }): Promise<unknown> {
    const { inventory_item_id, ...body } = params;
    return this.request(
      'POST',
      `inventory_items/${inventory_item_id}/inventory_moves.json`,
      undefined,
      body,
    );
  }

  // ── Generators (Invoice Templates) ─────────────────────────────────

  async listGenerators(params: { page?: number; since?: string }): Promise<unknown> {
    return this.request(
      'GET',
      'generators.json',
      params as Record<string, string | number | undefined>,
    );
  }

  async getGenerator(params: { id: number }): Promise<unknown> {
    return this.request('GET', `generators/${params.id}.json`);
  }

  async createGenerator(data: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', 'generators.json', undefined, data);
  }

  // ── Recurring Generators ───────────────────────────────────────────

  async listRecurringGenerators(params: { page?: number }): Promise<unknown> {
    return this.request(
      'GET',
      'recurring_generators.json',
      params as Record<string, string | number | undefined>,
    );
  }

  async getRecurringGenerator(params: { id: number }): Promise<unknown> {
    return this.request('GET', `recurring_generators/${params.id}.json`);
  }

  // ── Events (Audit Log) ─────────────────────────────────────────────

  async listEvents(params: {
    page?: number;
    since?: string;
    subject_id?: number;
  }): Promise<unknown> {
    return this.request(
      'GET',
      'events.json',
      params as Record<string, string | number | undefined>,
    );
  }

  // ── Todos ──────────────────────────────────────────────────────────

  async listTodos(params: { page?: number; since?: string }): Promise<unknown> {
    return this.request('GET', 'todos.json', params as Record<string, string | number | undefined>);
  }

  async toggleTodo(params: { id: number }): Promise<unknown> {
    return this.request('POST', `todos/${params.id}/toggle_completion.json`);
  }

  // ── Number Formats ──────────────────────────────────────────────────

  async listNumberFormats(): Promise<unknown> {
    return this.request('GET', 'number_formats.json');
  }

  // ── Tags ─────────────────────────────────────────────────────────────

  async listTags(): Promise<unknown> {
    return this.request('GET', 'tags.json');
  }
}
