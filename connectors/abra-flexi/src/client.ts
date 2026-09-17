/**
 * Abra Flexi REST API client — thin HTTP wrapper around safeFetch
 *
 * Auth: Basic auth (username:password)
 * API: https://{server}/c/{company}/{evidence}.json
 * Docs: https://podpora.flexibee.eu/en/collections/2592813-dokumentacia-rest-api
 *
 * Response format: { "winstrom": { "@version": "...", "evidence-name": [...] } }
 */

import { safeFetch } from '@dxheroes/mcp-kit';

/**
 * Error codes derived from the status codes ABRA Flexi actually documents.
 *
 * The REST API documents 400 (invalid request / failed PUT), 401 (bad or
 * missing credentials), 402 (REST write access not licensed), 403
 * (insufficient permissions / license limit), 404 (evidence or record not
 * found) and 405/406 (method or format not allowed for the resource).
 * `UNPROCESSABLE` and `RATE_LIMITED` are kept for 422/429 even though Flexi
 * documents neither: on-premise instances are commonly fronted by a reverse
 * proxy or WAF that emits them, and reporting those as a generic `API_ERROR`
 * would lose the one thing the status made clear.
 */
export type FlexiErrorCode =
  | 'INVALID_API_KEY'
  | 'PAYMENT_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'UNPROCESSABLE'
  | 'API_ERROR';

/**
 * Whether requests to the Flexi server may target a private-network address.
 *
 * `safeFetch` defaults this to `false`; the connector host's own policy
 * (`MCP_ALLOW_PRIVATE_NETWORK_TARGETS`) defaults to `true`. This package
 * preserves the established default and the operator's override alike. The
 * Flexi base URL is parsed out of the credential, and an on-premise Flexi on 10.x or behind a
 * loopback tunnel is the normal deployment, not the exception. Inheriting the
 * `safeFetch` default would break those installations on upgrade.
 *
 * Reading the variable rather than hardcoding `true` is what makes the override
 * mean something on the ONE path where the caller picks the outbound host.
 * Because the API key can be per-user, any user reachable by the
 * connection — an `end_user` included — chooses the target; a deployment
 * hardened with `MCP_ALLOW_PRIVATE_NETWORK_TARGETS=false` must reach them too.
 *
 * The established setting semantics are intentional: anything but the literal
 * string `false` means allowed, so an unset or misspelled value keeps today's
 * behaviour instead of silently hardening.
 *
 * Read per call, not once at import, so a test or a process that sets the
 * variable late sees the current value.
 *
 * What the flag does not relax, in either position: unspecified addresses and
 * the link-local range — including the cloud metadata endpoint 169.254.169.254
 * — stay blocked with `allowPrivate: true`, on the initial URL and on every
 * redirect hop, each of which is DNS-resolved and re-validated.
 */
function allowPrivateTargets(): boolean {
  return process.env.MCP_ALLOW_PRIVATE_NETWORK_TARGETS !== 'false';
}

/**
 * Actionable remedy for the codes where the status alone misleads.
 *
 * Flexi's 402 and 403 are the two that send people to re-check a password that
 * was never the problem, so both say what the status really means.
 */
function hintForCode(code: FlexiErrorCode): string | undefined {
  switch (code) {
    case 'INVALID_API_KEY':
      return 'Check the "username:password" half of the API key (format: "https://server/c/company|username:password").';
    case 'PAYMENT_REQUIRED':
      return 'ABRA Flexi returns 402 when REST write access is not licensed for this instance. Reads can keep working while writes fail; the credentials are not the problem.';
    case 'FORBIDDEN':
      return 'ABRA Flexi returns 403 for insufficient user permissions and for a license limit (such as the concurrent-user cap) alike. The credentials may be valid — check the rights of that Flexi user and how many sessions are open.';
    case 'NOT_FOUND':
      return 'ABRA Flexi returns 404 for an unknown evidence name as well as for a missing record. Verify the evidence spelling before concluding the record is gone.';
    default:
      return undefined;
  }
}

export class FlexiApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: FlexiErrorCode,
    /** Actionable remedy for the caller, when one is known. */
    public readonly hint?: string,
  ) {
    // `message` is the bare upstream text. The code is NOT prefixed here: the
    // server reports it as a separate field, and prefixing produced results
    // like `{"error":"BAD_REQUEST","message":"BAD_REQUEST: ..."}`.
    super(message);
    this.name = 'FlexiApiError';
  }
}

export class FlexiClient {
  private readonly authHeader: string;
  private readonly baseUrl: string;

  constructor(apiKey: string) {
    const separatorIndex = apiKey.indexOf('|');
    if (separatorIndex === -1) {
      throw new Error(
        'Invalid API key format. Expected "https://server/c/company|username:password". ' +
          'Example: "https://demo.flexibee.eu/c/demo|admin:admin"',
      );
    }

    this.baseUrl = apiKey.substring(0, separatorIndex).replace(/\/$/, '');
    const credentials = apiKey.substring(separatorIndex + 1);

    if (!this.baseUrl || !credentials?.includes(':')) {
      throw new Error(
        'Invalid API key format. Both server URL and credentials (user:pass) are required. ' +
          'Format: "https://server/c/company|username:password"',
      );
    }

    const encoded = Buffer.from(credentials).toString('base64');
    this.authHeader = `Basic ${encoded}`;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private buildUrl(
    evidence: string,
    id?: string | number,
    params?: Record<string, string | number | boolean | undefined>,
  ): string {
    let url = `${this.baseUrl}/${evidence}`;
    if (id !== undefined) {
      url += `/${id}`;
    }
    url += '.json';

    if (!params) return url;
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        searchParams.set(key, String(value));
      }
    }
    const qs = searchParams.toString();
    return qs ? `${url}?${qs}` : url;
  }

  /**
   * Turns a non-OK response into a `FlexiApiError`, preferring Flexi's own
   * message over the HTTP status text.
   *
   * Flexi answers every 4xx (500 excepted) with the same envelope it uses for
   * writes, so `winstrom.message` is the sentence a human should read.
   */
  private async errorFromResponse(response: Response): Promise<FlexiApiError> {
    const code = this.mapStatusToCode(response.status);
    let message: string;
    try {
      const errorBody = await response.text();
      // Try to parse Flexi error format
      try {
        const parsed = JSON.parse(errorBody);
        if (parsed?.winstrom?.message) {
          message = parsed.winstrom.message;
        } else {
          message = errorBody;
        }
      } catch {
        message = errorBody || response.statusText;
      }
    } catch {
      message = response.statusText;
    }
    return new FlexiApiError(message, response.status, code, hintForCode(code));
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    evidence: string,
    id?: string | number,
    params?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
  ): Promise<T> {
    const url = this.buildUrl(evidence, id, params);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      // Flexi expects data wrapped in { "winstrom": { "evidence-name": { ... } } }
      init.body = JSON.stringify({ winstrom: { [evidence]: body } });
    }

    const response = await safeFetch(url, { ...init, allowPrivate: allowPrivateTargets() });

    if (method === 'DELETE' && response.ok) {
      return undefined as T;
    }

    if (!response.ok) {
      throw await this.errorFromResponse(response);
    }

    const text = await response.text();
    if (!text) return undefined as T;

    const parsed = JSON.parse(text);
    // Unwrap Flexi response wrapper
    if (parsed?.winstrom) {
      return parsed.winstrom as T;
    }
    return parsed as T;
  }

  /**
   * Maps a Flexi HTTP status onto an error code.
   *
   * 401 and 403 used to collapse into `INVALID_API_KEY`, which sent callers to
   * re-check credentials that were fine: Flexi documents 403 as "insufficient
   * permissions / license limit", a different problem with a different remedy.
   * 402 ("REST write access not licensed") is a third one again.
   */
  private mapStatusToCode(status: number): FlexiErrorCode {
    if (status === 401) return 'INVALID_API_KEY';
    if (status === 402) return 'PAYMENT_REQUIRED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 404) return 'NOT_FOUND';
    if (status === 429) return 'RATE_LIMITED';
    // Flexi answers a rejected write with 400, and rejects an unsupported
    // method or Accept type with 405/406 — all three mean the request itself
    // was wrong, not the server.
    if (status === 400 || status === 405 || status === 406) return 'BAD_REQUEST';
    if (status === 422) return 'UNPROCESSABLE';
    return 'API_ERROR';
  }

  // ── Validation ───────────────────────────────────────────────────────

  /**
   * Checks the credentials against the company root.
   *
   * This deliberately keeps its own request instead of going through
   * `request()`: the company root is `{baseUrl}.json`, not the
   * `{baseUrl}/{evidence}.json` shape `buildUrl` produces, and special-casing
   * that in `buildUrl` would add more coupling than it removes. The status
   * mapping — the part that was genuinely duplicated — is shared.
   */
  async validateApiKey(): Promise<{ valid: boolean; error?: string }> {
    try {
      // Fetch company info to validate credentials
      const url = `${this.baseUrl}.json`;
      const response = await safeFetch(url, {
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
        },
        allowPrivate: allowPrivateTargets(),
      });
      if (!response.ok) {
        const code = this.mapStatusToCode(response.status);
        // Both still mean "these credentials cannot be used against this
        // company", even though they are different problems upstream — the
        // split in `mapStatusToCode` must not change that verdict.
        if (code === 'INVALID_API_KEY') {
          return { valid: false, error: 'Invalid credentials' };
        }
        if (code === 'FORBIDDEN') {
          return {
            valid: false,
            error:
              'Credentials rejected (HTTP 403): insufficient permissions or a license limit. ABRA Flexi returns 403 for both.',
          };
        }
        return { valid: false, error: `Server returned ${response.status}` };
      }
      return { valid: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { valid: false, error: `Validation failed: ${message}` };
    }
  }

  // ── Account ──────────────────────────────────────────────────────────

  async getAccountInfo(): Promise<unknown> {
    const url = `${this.baseUrl}.json`;
    const response = await safeFetch(url, {
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
      },
      allowPrivate: allowPrivateTargets(),
    });
    if (!response.ok) {
      throw await this.errorFromResponse(response);
    }
    const parsed = JSON.parse(await response.text());
    return parsed?.winstrom ?? parsed;
  }

  // ── Generic list/get/create ──────────────────────────────────────────

  async listRecords(
    evidence: string,
    params?: {
      limit?: number;
      start?: number;
      order?: string;
      filter?: string;
      detail?: string;
    },
  ): Promise<unknown> {
    return this.request(
      'GET',
      evidence,
      undefined,
      params as Record<string, string | number | undefined>,
    );
  }

  async getRecord(evidence: string, id: string | number): Promise<unknown> {
    return this.request('GET', evidence, id);
  }

  async createRecord(evidence: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', evidence, undefined, undefined, data);
  }

  async updateRecord(
    evidence: string,
    id: string | number,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request('PUT', evidence, id, undefined, data);
  }

  async deleteRecord(evidence: string, id: string | number): Promise<unknown> {
    return this.request('DELETE', evidence, id);
  }

  // ── Issued Invoices (faktura-vydana) ─────────────────────────────────

  async listIssuedInvoices(params?: {
    limit?: number;
    start?: number;
    order?: string;
    filter?: string;
  }): Promise<unknown> {
    return this.listRecords('faktura-vydana', params);
  }

  async getIssuedInvoice(id: string | number): Promise<unknown> {
    return this.getRecord('faktura-vydana', id);
  }

  async createIssuedInvoice(data: Record<string, unknown>): Promise<unknown> {
    return this.createRecord('faktura-vydana', data);
  }

  async updateIssuedInvoice(id: string | number, data: Record<string, unknown>): Promise<unknown> {
    return this.updateRecord('faktura-vydana', id, data);
  }

  // ── Received Invoices (faktura-prijata) ──────────────────────────────

  async listReceivedInvoices(params?: {
    limit?: number;
    start?: number;
    order?: string;
    filter?: string;
  }): Promise<unknown> {
    return this.listRecords('faktura-prijata', params);
  }

  async createReceivedInvoice(data: Record<string, unknown>): Promise<unknown> {
    return this.createRecord('faktura-prijata', data);
  }

  async getReceivedInvoice(id: string | number): Promise<unknown> {
    return this.getRecord('faktura-prijata', id);
  }

  async updateReceivedInvoice(
    id: string | number,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    return this.updateRecord('faktura-prijata', id, data);
  }

  // ── Contacts (adresar) ──────────────────────────────────────────────

  async listContacts(params?: {
    limit?: number;
    start?: number;
    order?: string;
    filter?: string;
  }): Promise<unknown> {
    return this.listRecords('adresar', params);
  }

  async getContact(id: string | number): Promise<unknown> {
    return this.getRecord('adresar', id);
  }

  async createContact(data: Record<string, unknown>): Promise<unknown> {
    return this.createRecord('adresar', data);
  }

  async updateContact(id: string | number, data: Record<string, unknown>): Promise<unknown> {
    return this.updateRecord('adresar', id, data);
  }

  // ── Bank Statements (banka) ─────────────────────────────────────────

  async listBankStatements(params?: {
    limit?: number;
    start?: number;
    order?: string;
    filter?: string;
  }): Promise<unknown> {
    return this.listRecords('banka', params);
  }

  // ── Products (cenik) ────────────────────────────────────────────────

  async listProducts(params?: {
    limit?: number;
    start?: number;
    order?: string;
    filter?: string;
  }): Promise<unknown> {
    return this.listRecords('cenik', params);
  }

  async createProduct(data: Record<string, unknown>): Promise<unknown> {
    return this.createRecord('cenik', data);
  }

  async updateProduct(id: string | number, data: Record<string, unknown>): Promise<unknown> {
    return this.updateRecord('cenik', id, data);
  }

  // ── Orders Received (objednavka-prijata) ──────────────────────────────

  async listOrdersReceived(params?: {
    limit?: number;
    start?: number;
    order?: string;
    filter?: string;
  }): Promise<unknown> {
    return this.listRecords('objednavka-prijata', params);
  }

  async createOrderReceived(data: Record<string, unknown>): Promise<unknown> {
    return this.createRecord('objednavka-prijata', data);
  }

  // ── Orders Issued (objednavka-vydana) ─────────────────────────────────

  async listOrdersIssued(params?: {
    limit?: number;
    start?: number;
    order?: string;
    filter?: string;
  }): Promise<unknown> {
    return this.listRecords('objednavka-vydana', params);
  }

  async createOrderIssued(data: Record<string, unknown>): Promise<unknown> {
    return this.createRecord('objednavka-vydana', data);
  }

  // ── Cash Movements (pokladni-pohyb) ───────────────────────────────────

  async listCashMovements(params?: {
    limit?: number;
    start?: number;
    order?: string;
    filter?: string;
  }): Promise<unknown> {
    return this.listRecords('pokladni-pohyb', params);
  }

  // ── Internal Documents (interni-doklad) ───────────────────────────────

  async listInternalDocuments(params?: {
    limit?: number;
    start?: number;
    order?: string;
    filter?: string;
  }): Promise<unknown> {
    return this.listRecords('interni-doklad', params);
  }

  async createInternalDocument(data: Record<string, unknown>): Promise<unknown> {
    return this.createRecord('interni-doklad', data);
  }

  // ── Stock Movements (skladovy-pohyb) ──────────────────────────────────

  async listStockMovements(params?: {
    limit?: number;
    start?: number;
    order?: string;
    filter?: string;
  }): Promise<unknown> {
    return this.listRecords('skladovy-pohyb', params);
  }
}
