import { callSignal } from '@dxheroes/mcp-kit';
/**
 * How a Toggl request is made — auth, pacing, scrubbing, error mapping.
 *
 * Auth: HTTP Basic — base64(apiToken:api_token)
 * Track API: https://api.track.toggl.com/api/v9
 * Reports API: https://api.track.toggl.com/reports/api/v3
 * Rate limit: 1 req/sec per IP per token
 *
 * Split out of `client.ts` so the endpoint surface is not read through the
 * plumbing. `TogglClient` extends this, so nothing about its public API moved.
 */

import { createHash } from 'node:crypto';
import type { RateLimitRetryInfo } from '@dxheroes/mcp-kit';
// The scrubbing and the 429 pacing are the generic halves of two mechanisms
// this package used to own alone. What stays here is the policy — which
// keys are credentials, how fast Toggl may be called, what the caller is told
// when the wait is refused; core supplies the mechanism that applies it.
import { RateLimitPacer, SecretScrubber } from '@dxheroes/mcp-kit';
import { extractErrorMessage, TogglApiError, type TogglErrorCode } from './client.errors.js';
import { buildErrorHint, type ErrorHintContext } from './client.hints.js';
import {
  describeWait,
  MIN_REQUEST_INTERVAL_MS,
  RATE_LIMIT_FALLBACK_DELAYS_MS,
  RATE_LIMIT_MAX_ATTEMPTS,
  RATE_LIMIT_MAX_SINGLE_WAIT_MS,
  RATE_LIMIT_TOTAL_WAIT_BUDGET_MS,
  TOGGL_PACING_NAMESPACE,
} from './client.pacing.js';
import { dropDuplicateAliases } from './client.payload.js';
import {
  ICAL_PATH_PATTERN,
  MIN_SCRUBBED_SECRET_LENGTH,
  REDACTED_KEY_STEMS,
  TOGGL_TOKEN_PATTERN,
} from './client.redaction.js';

/**
 * Knobs the tests need to drive and nothing else does.
 *
 * Real callers construct the client with a token alone; the pacing interval and
 * the sleep are only parameters because a suite cannot wait a real second per
 * request, and because asserting on *how long* the client would wait is the
 * only way to test the retry schedule without testing the clock.
 */
export interface TogglClientOptions {
  /** Minimum gap between two requests on the same token. Defaults to 1000 ms. */
  minRequestIntervalMs?: number;
  /** Total attempts per request, retries included. Defaults to 3. */
  maxRateLimitAttempts?: number;
  /** Injected so tests do not sleep. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so tests can pin the clock. Defaults to `Date.now`. */
  now?: () => number;
}

// ── Helpers ──────────────────────────────────────────────────────────
//
// Free functions rather than methods: neither touches `this`.

function buildUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  const url = `${baseUrl}${path}`;
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

function mapStatusToCode(status: number): TogglErrorCode {
  if (status === 401) return 'INVALID_API_KEY';
  if (status === 402) return 'PAYMENT_REQUIRED';
  // Toggl returns 403 both for a bad token and for "you may not touch this
  // resource" (missing workspace permission, or a paid-only feature such as
  // tasks). Reporting it as INVALID_API_KEY sent callers to re-check a token
  // that was fine, so it gets its own code; `validateApiKey()` still treats a
  // 403 on `/me` as a token problem.
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400) return 'BAD_REQUEST';
  return 'API_ERROR';
}

/**
 * Transport for both Toggl APIs: one paced, scrubbed, error-mapped request.
 *
 * `track()` and `report()` are `protected` rather than `private` only because
 * the endpoint methods now live in a subclass; nothing about the public surface
 * of `TogglClient` changed with the split.
 */
export class TogglHttpClient {
  private readonly authHeader: string;
  private readonly trackBaseUrl: string;
  private readonly reportsBaseUrl: string;
  /**
   * Redacts every response body and every error body. Applied at the one choke
   * point in {@link TogglClient.request}, never at a call site.
   */
  private readonly scrubber: SecretScrubber;
  /** Paces and retries requests. Its slots are shared per token, not per instance. */
  private readonly pacer: RateLimitPacer;
  /**
   * Identifies the account in the shared pacing slots without storing the token
   * there. Two clients built from the same token share one slot, which is the
   * whole point.
   */
  private readonly pacingKey: string;

  constructor(
    apiToken: string,
    trackBaseUrl = 'https://api.track.toggl.com/api/v9',
    reportsBaseUrl = 'https://api.track.toggl.com/reports/api/v3',
    options: TogglClientOptions = {},
  ) {
    const encoded = Buffer.from(`${apiToken}:api_token`).toString('base64');
    this.authHeader = `Basic ${encoded}`;
    this.trackBaseUrl = trackBaseUrl;
    this.reportsBaseUrl = reportsBaseUrl;
    this.pacingKey = createHash('sha256').update(apiToken).digest('hex');
    this.pacer = new RateLimitPacer({
      namespace: TOGGL_PACING_NAMESPACE,
      minRequestIntervalMs: options.minRequestIntervalMs ?? MIN_REQUEST_INTERVAL_MS,
      maxAttempts: options.maxRateLimitAttempts ?? RATE_LIMIT_MAX_ATTEMPTS,
      fallbackDelaysMs: RATE_LIMIT_FALLBACK_DELAYS_MS,
      maxSingleWaitMs: RATE_LIMIT_MAX_SINGLE_WAIT_MS,
      totalWaitBudgetMs: RATE_LIMIT_TOTAL_WAIT_BUDGET_MS,
      now: options.now,
      sleep: options.sleep,
      // The refusal is Toggl's to word, not core's: it has to name the shared
      // slot, because the caller's own restraint is not what pushed it out.
      onQueueRefused: ({ queueWaitMs }) =>
        new TogglApiError(
          `This client paces requests to roughly one per second per Toggl API token, and the next free slot for this token is ${describeWait(queueWaitMs)} away — longer than a tool call may block. The request was not sent, so it cost nothing against Toggl's limit.`,
          429,
          'RATE_LIMITED',
          `Wait about ${describeWait(queueWaitMs)} and try again, or issue fewer Toggl calls at once: the slot is shared by every profile and every host session using this API token, and a recent 429 from Toggl pushes it further out for all of them.`,
        ),
    });
    // The Basic credential is always scrubbed by value: it is long, derived and
    // cannot collide with real data. Key-based redaction alone would miss it,
    // and would miss an intermediary (corporate egress proxy, WAF) whose block
    // page quotes the request — including `Authorization: Basic …`.
    const secrets = [encoded];
    if (TOGGL_TOKEN_PATTERN.test(apiToken)) {
      secrets.push(apiToken);
    } else {
      // Not silent degradation in either direction: the token still
      // authenticates, but a token-shaped check is the only thing that makes
      // replacing it by value safe, so the operator is told what is reduced.
      console.warn(
        '[Toggl] The configured API token does not look like a Toggl API token (32 hex characters). It is still used for authentication, but value-based scrubbing is limited to the derived Basic credential: a token echoed verbatim by an upstream error page would not be recognised. Redaction by key (api_token, intercom_hash, ical_url) is unaffected.',
      );
    }
    this.scrubber = new SecretScrubber({
      redactedKeyStems: REDACTED_KEY_STEMS,
      secretValues: secrets,
      capturePatterns: [ICAL_PATH_PATTERN],
      minSecretLength: MIN_SCRUBBED_SECRET_LENGTH,
    });
  }

  // ── Rate limiting ────────────────────────────────────────────────────

  /**
   * Issues one request, pacing it and retrying a 429 within budget.
   *
   * A 429 that survives the retries is returned, not thrown: `request()` turns
   * it into the same `RATE_LIMITED` error it always did, only now carrying what
   * was already tried so the hint can say something the caller has not done yet.
   *
   * Paced here rather than at the call sites, for the same reason the scrubbing
   * is: one choke point every endpoint — present and future — goes through
   * without having to remember.
   */
  private pacedFetch(
    url: string,
    init: RequestInit,
  ): Promise<{ response: Response; rateLimit?: RateLimitRetryInfo }> {
    return this.pacer.run(this.pacingKey, () => {
      const signal = callSignal(init.signal);
      return fetch(url, signal ? { ...init, signal } : init);
    });
  }

  // ── Requests ─────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    baseUrl: string,
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
    hintContext?: ErrorHintContext,
  ): Promise<T> {
    const url = buildUrl(baseUrl, path, params);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    // Paced and retried here rather than at the call sites, for the same reason
    // the scrubbing below lives here: one choke point that every endpoint —
    // present and future — goes through without having to remember.
    const { response, rateLimit } = await this.pacedFetch(url, init);

    // DELETE returns 200 with no body
    if (method === 'DELETE' && response.ok) {
      return undefined as T;
    }

    if (!response.ok) {
      const code = mapStatusToCode(response.status);
      const fallback = response.statusText || `HTTP ${response.status}`;
      let message: string;
      try {
        // Scrubbed like any other upstream content: an error body is the one
        // path that hands raw remote text back to the caller.
        message = this.scrubber.scrubText(extractErrorMessage(await response.text(), fallback));
      } catch {
        message = fallback;
      }
      throw new TogglApiError(
        message,
        response.status,
        code,
        buildErrorHint(
          code,
          message,
          path,
          rateLimit ? { ...hintContext, rateLimit } : hintContext,
        ),
      );
    }

    // Some endpoints return empty body on success
    const text = await response.text();
    if (!text) return undefined as T;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // The SyntaxError is deliberately dropped rather than reported: Node
      // quotes the first characters of the body in its message, which would
      // walk a credential straight past the scrubber. A 200 whose body is not
      // JSON is not the API answering anyway — a transparent proxy or captive
      // portal echoing the request is the realistic case, and that echo may be
      // the `Authorization` header.
      throw new TogglApiError(
        'Toggl returned a success status with a body that is not JSON. The response did not come from the Toggl API — most likely an intermediary (egress proxy, captive portal) answered instead. The body is not reported here because it may contain the request credentials.',
        response.status,
        'API_ERROR',
        'Do not retry in a loop. Report to the operator that requests to api.track.toggl.com are being intercepted or rewritten.',
      );
    }
    // Every payload is scrubbed here, not at individual call sites: any
    // endpoint may embed a credential (Toggl's own API definition puts
    // `api_token` and `ical_url` on several workspace and user models).
    //
    // Compaction runs strictly *after* scrubbing and never before it: the
    // scrubber must see the payload Toggl actually sent, and a transformation
    // that ran first could hide a credential-bearing key from it. Dropping a
    // proven duplicate id cannot un-redact anything — it only ever deletes a
    // key whose value is identical to one that stays.
    return dropDuplicateAliases(this.scrubber.scrub(parsed as T));
  }

  protected track<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
    hintContext?: ErrorHintContext,
  ): Promise<T> {
    return this.request<T>(method, this.trackBaseUrl, path, params, body, hintContext);
  }

  protected report<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', this.reportsBaseUrl, path, undefined, body);
  }

  // ── Validation ───────────────────────────────────────────────────────

  async validateApiKey(): Promise<{ valid: boolean; error?: string }> {
    try {
      await this.track('GET', '/me');
      return { valid: true };
    } catch (error) {
      // A 401 or a 403 on `/me` both mean the token itself is not usable.
      if (
        error instanceof TogglApiError &&
        (error.code === 'INVALID_API_KEY' || error.code === 'FORBIDDEN')
      ) {
        return { valid: false, error: 'Invalid API token' };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { valid: false, error: `Validation failed: ${message}` };
    }
  }
}
