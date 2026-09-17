/**
 * Merk API client — thin HTTP wrapper around safeFetch
 *
 * One method per API endpoint. Auth: Token {api_key}
 * Base URL: https://api.merk.cz
 * Docs: https://api.merk.cz/docs/
 */

import { safeFetch } from '@dxheroes/mcp-kit';

export type MerkErrorCode =
  | 'INVALID_API_KEY'
  | 'FORBIDDEN'
  | 'PAYMENT_REQUIRED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'API_ERROR';

export class MerkApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: MerkErrorCode,
    /** Actionable remedy for the caller, when one is known. */
    public readonly hint?: string,
  ) {
    // `message` is the bare upstream text — Merk's `detail`, or the status
    // text when there is no body to read. The code is deliberately NOT
    // prefixed onto it: `MerkMcpServer` reports the code as its own field, so
    // prefixing produced `{"error":"BAD_REQUEST","message":"BAD_REQUEST: …"}`,
    // the same token twice in one payload.
    super(message);
    this.name = 'MerkApiError';
  }
}

/**
 * What the caller can usefully do about each code.
 *
 * Merk's own documentation (https://api.merk.cz/docs/) was not reachable from
 * the environment this was written in, so every hint below is limited to what
 * the HTTP status itself means and what can be checked from inside this
 * package. None of them claims anything about what a Merk plan includes.
 */
const ERROR_HINTS: Partial<Record<MerkErrorCode, string>> = {
  INVALID_API_KEY:
    'Merk rejected the token itself. Check the Merk API key in the MCP server settings — it may be mistyped, revoked, or expired.',
  FORBIDDEN:
    'The token was accepted; this particular request was not permitted, so re-issuing the token is unlikely to help. Call merk_subscription_info to see what the current plan covers.',
  PAYMENT_REQUIRED:
    'Merk answered 402, which means payment is owed or a paid quota is exhausted. Call merk_subscription_info to check the plan and what is left of it.',
  RATE_LIMITED:
    'Too many requests in too short a window. Wait before retrying — this package does not retry or pace requests on its own.',
  BAD_REQUEST:
    'Merk rejected the parameters. Its field-level validation errors are not always carried in the `detail` key, so the message above may be only the status text — re-check the values that were sent.',
};

export class MerkClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://api.merk.cz') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private buildUrl(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = `${this.baseUrl}${path}`;
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

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    const headers: Record<string, string> = {
      Authorization: `Token ${this.apiKey}`,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await safeFetch(url, {
      ...init,
      // The connector host's own default (MCP_ALLOW_PRIVATE_NETWORK_TARGETS) is to
      // permit private-network targets, and pointing this client at an
      // internally reachable host is a setup the connector host already allows, so
      // blocking it here would break deployments rather than harden them.
      // Link-local and the cloud metadata endpoint stay blocked regardless.
      allowPrivate: true,
    });

    if (!response.ok) {
      const code = this.mapStatusToCode(response.status);
      let message: string;
      try {
        const errorBody = await response.json();
        message = (errorBody as { detail?: string }).detail || response.statusText;
      } catch {
        message = response.statusText;
      }
      throw new MerkApiError(message, response.status, code, ERROR_HINTS[code]);
    }

    // 204 and 205 carry no body by definition. A 200 with an empty body is
    // not supposed to happen — but when it did, this fell through to
    // `response.json()`, which rejects with a SyntaxError, and the model was
    // told `{"error":"API_ERROR","message":"Unexpected end of JSON input"}`:
    // a request that succeeded, reported as a failure. Read the body once as
    // text and decide from what is actually in it.
    //
    // An absent body is reported as `undefined`, not `null`. `null` is a value
    // Merk can legitimately put in a JSON body, and collapsing the two left
    // the server unable to tell "Merk said null" from "Merk said nothing".
    // `MerkMcpServer.successPayload()` turns the `undefined` into a sentence
    // the model can act on; a real `null` passes through untouched.
    if (response.status === 204 || response.status === 205) {
      return undefined as T;
    }
    const text = await response.text();
    if (text.trim().length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MerkApiError(
        `Merk returned a ${response.status} response whose body is not valid JSON`,
        response.status,
        'API_ERROR',
        'The request reached Merk and it reported success, but the payload could not be parsed. Retry once; if it persists, the endpoint is answering with something other than JSON.',
      );
    }
  }

  /**
   * Merk is a Django REST Framework service — the `Authorization: Token …`
   * scheme, the trailing-slash paths and the `detail` key on error bodies are
   * all DRF defaults — and DRF is what fixes the meaning of these statuses:
   *
   * - **401** is `TokenAuthentication` failing: the token is missing, wrong,
   *   or revoked.
   * - **403** is a permission check that ran *after* authentication already
   *   succeeded. The token is fine; this caller may not have this. Reporting
   *   it as INVALID_API_KEY sent people to re-issue a token that worked, so it
   *   gets its own code. `validateApiKey()` is the one place that still treats
   *   a 403 as a token problem, and says why.
   * - **400** is `ValidationError`, whose body is keyed by field rather than
   *   by `detail` — see the BAD_REQUEST hint.
   *
   * **402 is unverified.** DRF does not emit it by default and it was not
   * observed against Merk: api.merk.cz was unreachable from the environment
   * this was written in, so the documentation could not be checked. It is
   * mapped anyway because the meaning of 402 is fixed by RFC 9110 rather than
   * by any one API, and the alternative is worse — unmapped it falls into
   * API_ERROR, which this package documents as a server fault.
   */
  private mapStatusToCode(status: number): MerkErrorCode {
    if (status === 401) return 'INVALID_API_KEY';
    if (status === 402) return 'PAYMENT_REQUIRED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 404) return 'NOT_FOUND';
    if (status === 429) return 'RATE_LIMITED';
    if (status === 400) return 'BAD_REQUEST';
    return 'API_ERROR';
  }

  // ── Validation ───────────────────────────────────────────────────────

  async validateApiKey(): Promise<{ valid: boolean; error?: string }> {
    try {
      await this.request('GET', '/subscriptions/');
      return { valid: true };
    } catch (error) {
      // A 401 is the token being rejected outright. A 403 is deliberately
      // *not* a token problem everywhere else in this client — but
      // `/subscriptions/` is the account's own plan, the least privileged
      // thing this token could ask for, so a token that may not read it is not
      // a token this package can work with either.
      if (
        error instanceof MerkApiError &&
        (error.code === 'INVALID_API_KEY' || error.code === 'FORBIDDEN')
      ) {
        return { valid: false, error: 'Invalid API key' };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { valid: false, error: `Validation failed: ${message}` };
    }
  }

  // ── Company endpoints ────────────────────────────────────────────────

  async companyLookup(params: {
    regno?: string;
    vatno?: string;
    country_code?: string;
    src_app?: string;
  }): Promise<unknown> {
    return this.request('GET', '/company/', params);
  }

  async companyBatch(params: {
    regnos: string[];
    country_code?: string;
    src_app?: string;
  }): Promise<unknown> {
    if (params.regnos.length > 500) {
      throw new MerkApiError('Maximum 500 regnos per batch request', 400, 'BAD_REQUEST');
    }
    const body: Record<string, unknown> = { regnos: params.regnos };
    if (params.country_code) body.country_code = params.country_code;
    if (params.src_app) body.src_app = params.src_app;
    return this.request('POST', '/company/mget/', undefined, body);
  }

  async suggest(params: {
    query?: string;
    country?: string;
    name?: string;
    email?: string;
    bank_account?: string;
    only_active?: boolean;
    country_code?: string;
    regno?: string;
    sort_by?: string;
    birth_date?: string;
    expand_regno?: boolean;
    include_historic?: boolean;
  }): Promise<unknown> {
    const queryParams: Record<string, string | boolean | undefined> = {
      name: params.name ?? params.query,
      email: params.email,
      bank_account: params.bank_account,
      regno: params.regno,
      country_code: params.country_code ?? params.country,
      only_active: params.only_active,
      sort_by: params.sort_by,
      birth_date: params.birth_date,
      expand_regno: params.expand_regno,
      include_historic: params.include_historic,
    };

    return this.request('GET', '/suggest/', queryParams);
  }

  async searchCompanies(params: {
    country?: 'cz' | 'sk';
    country_code?: 'cz' | 'sk';
    query?: string;
    ordering?: string[] | string;
    filters?: Record<string, unknown>;
    page?: number;
    page_size?: number;
    limit?: number;
    [key: string]: unknown;
  }): Promise<unknown> {
    const {
      country,
      country_code,
      query,
      ordering,
      filters = {},
      page,
      page_size,
      limit,
      ...bodyFields
    } = params;
    const resolvedCountry = country ?? country_code ?? 'cz';
    const resolvedPageSize = page_size ?? limit;
    const queryParams: Record<string, string | number | undefined> = {};
    if (query) queryParams.query = query;
    if (ordering) queryParams.ordering = Array.isArray(ordering) ? ordering.join(',') : ordering;
    if (page !== undefined) queryParams.page = page;
    if (resolvedPageSize !== undefined) queryParams.page_size = resolvedPageSize;

    const body = {
      ...filters,
      ...bodyFields,
    };

    return this.request(
      'POST',
      `/search/${resolvedCountry}/`,
      queryParams,
      Object.keys(body).length > 0 ? body : undefined,
    );
  }

  async financialStatements(params: { regno: string; country_code?: string }): Promise<unknown> {
    return this.request(
      'GET',
      '/company/financial-statements/',
      params as Record<string, string | undefined>,
    );
  }

  async financialIndicators(params: { regno: string; country_code?: string }): Promise<unknown> {
    return this.request(
      'GET',
      '/company/financial-indicators/',
      params as Record<string, string | undefined>,
    );
  }

  async companyEmployees(params: {
    regno: string;
    country_code?: string;
    page?: number;
    page_size?: number;
  }): Promise<unknown> {
    return this.request(
      'GET',
      '/company/employees/',
      params as Record<string, string | number | undefined>,
    );
  }

  async companyFleet(params: { regno: string; country_code?: string }): Promise<unknown> {
    return this.request('GET', '/company/fleet/', params as Record<string, string | undefined>);
  }

  async companyFleetStats(params: { regno: string; country_code?: string }): Promise<unknown> {
    return this.request(
      'GET',
      '/company/fleet-stats/',
      params as Record<string, string | undefined>,
    );
  }

  async companyBusinessPremises(params: {
    regno: string;
    country_code?: string;
  }): Promise<unknown> {
    return this.request(
      'GET',
      '/company/business-premises/',
      params as Record<string, string | undefined>,
    );
  }

  async companyLicenses(params: { regno: string; country_code?: string }): Promise<unknown> {
    return this.request('GET', '/company/licenses/', params as Record<string, string | undefined>);
  }

  async companyEvents(params: {
    regno?: string;
    from_date: string;
    to_date: string;
    country_code?: string;
    action_id?: number;
    event_id?: number;
  }): Promise<unknown> {
    return this.request(
      'GET',
      '/company/events/',
      params as Record<string, string | number | undefined>,
    );
  }

  async newCompanies(params: {
    from_date: string;
    to_date: string;
    country_code?: string;
    page?: number;
    page_size?: number;
  }): Promise<unknown> {
    return this.request(
      'GET',
      '/company/new2/',
      params as Record<string, string | number | undefined>,
    );
  }

  async updatedCompanies(params: {
    from_date: string;
    to_date: string;
    country_code?: string;
    page?: number;
    page_size?: number;
  }): Promise<unknown> {
    return this.request(
      'GET',
      '/company/updates2/',
      params as Record<string, string | number | undefined>,
    );
  }

  async companyJobAds(params: { regno: string; country_code?: string }): Promise<unknown> {
    return this.request('GET', '/company/job-ads/', params as Record<string, string | undefined>);
  }

  async companyGovContracts(params: { regno: string; country_code?: string }): Promise<unknown> {
    return this.request(
      'GET',
      '/company/gov-contracts/',
      params as Record<string, string | undefined>,
    );
  }

  // ── Relations endpoints ──────────────────────────────────────────────

  async relationsCompany(params: {
    company_id?: string;
    regno?: string;
    relation_type: string;
    country_code?: string;
    hops?: number;
    from_date_gte?: string;
    to_date_lte?: string;
    share_gte?: number;
    company_role_id?: number;
  }): Promise<unknown> {
    const companyId =
      params.company_id ??
      (params.regno ? `${params.country_code ?? 'cz'}-${params.regno}` : undefined);

    const queryParams: Record<string, string | number | undefined> = {
      company_id: companyId,
      relation_type: params.relation_type,
      country_code: params.country_code,
      hops: params.hops,
      from_date_gte: params.from_date_gte,
      to_date_lte: params.to_date_lte,
      share_gte: params.share_gte,
      company_role_id: params.company_role_id,
    };

    return this.request('GET', '/relations/company/', queryParams);
  }

  async relationsPerson(params: {
    person_id: string;
    relation_type: string;
    country_code?: string;
    hops?: number;
    from_date_gte?: string;
    to_date_lte?: string;
    share_gte?: number;
    company_role_id?: number;
  }): Promise<unknown> {
    return this.request(
      'GET',
      '/relations/person/',
      params as Record<string, string | number | undefined>,
    );
  }

  async relationsSearchPerson(params: {
    name: string;
    birth_date?: string;
    country_code?: string;
  }): Promise<unknown> {
    return this.request(
      'GET',
      '/relations/search/person/',
      params as Record<string, string | undefined>,
    );
  }

  async relationsShortestPath(params: {
    node1_id: string;
    node1_label: string;
    node2_id: string;
    node2_label: string;
    relation_type: string;
    country_code?: string;
    hops?: number;
  }): Promise<unknown> {
    return this.request(
      'GET',
      '/relations/shortest-path/',
      params as Record<string, string | number | undefined>,
    );
  }

  // ── Utility endpoints ────────────────────────────────────────────────

  async enums(params: { id?: string; enum_id?: string; country_code?: string }): Promise<unknown> {
    const enumId = params.id ?? params.enum_id;
    const path = enumId ? `/enums/${enumId}/` : '/enums/';
    const queryParams: Record<string, string | undefined> = {};
    if (params.country_code) queryParams.country_code = params.country_code;
    return this.request('GET', path, queryParams);
  }

  async subscriptionInfo(): Promise<unknown> {
    return this.request('GET', '/subscriptions/');
  }

  async vokativ(params: { first_name?: string; last_name?: string }): Promise<unknown> {
    return this.request('GET', '/vokativ/', params as Record<string, string | undefined>);
  }
}
