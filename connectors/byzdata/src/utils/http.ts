/**
 * Shared HTTP layer for the three ByzData upstreams (ARES, or.justice.cz, eISIR).
 *
 * Two things are centralised here on purpose:
 *
 * 1. **Every outbound request goes through `safeFetch`.** All three base URLs
 *    are constants, so this is a consistency measure rather than the closing
 *    of a hole — nothing in a tool input can steer the target. What it does
 *    buy is that redirects are followed manually and revalidated hop by hop,
 *    so a registry that starts 302-ing somewhere else cannot walk the request
 *    onto a link-local address.
 *
 * 2. **Every failure arrives as a `ByzdataError` carrying a `code`.** The code
 *    is a separate field, never a prefix on `message`: the tool response
 *    serialises `{ error, message, hint }` and a code baked into the text
 *    produces `UPSTREAM_ERROR: "UPSTREAM_ERROR: ..."`. A model reading the
 *    response needs "what do I do now" more than it needs "what happened",
 *    which is what `hint` is for.
 */

import { safeFetch } from '@dxheroes/mcp-kit';

/**
 * Machine-readable failure kinds.
 *
 * Deliberately small. The split that matters for a registry service is
 * "the registry says there is no such record" (`NOT_FOUND`) versus "the
 * registry did not answer" (`UPSTREAM_UNAVAILABLE`, `NETWORK_ERROR`,
 * `RATE_LIMITED`) — reporting the second as the first is how a model ends up
 * telling a user a company does not exist because ARES was down.
 */
export type ByzdataErrorCode =
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  | 'NETWORK_ERROR';

/** Which public registry a failure came from, so the model can name it. */
export type ByzdataSource = 'ARES' | 'justice.cz' | 'ISIR';

/** All three upstreams get the same ceiling; none of them is fast. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Remediation text per code.
 *
 * These say what the caller should do, not what went wrong — the message
 * already carries that. `NOT_FOUND` has no entry: whether an absent record is
 * an answer or a problem depends on the lookup, so the call site supplies it.
 */
const DEFAULT_HINTS: Partial<Record<ByzdataErrorCode, string>> = {
  BAD_REQUEST:
    'The registry rejected the request as malformed. Check the IČO — it must be 1-8 digits — and do not retry the same value unchanged.',
  FORBIDDEN:
    'The registry refused the request. These are public endpoints, so this usually means the caller is being blocked (rate limiting by IP, or a changed access policy) rather than that the data is restricted.',
  RATE_LIMITED:
    'The registry is throttling this caller. Wait before retrying and avoid issuing further lookups in the meantime; a fan-out over many companies is the usual cause.',
  UPSTREAM_UNAVAILABLE:
    'The registry itself failed, so nothing is known about this company right now. Retry later. Do NOT report the company as missing or clean on the strength of this.',
  UPSTREAM_ERROR:
    'The registry answered with an unexpected status. Retry once; if it repeats, the endpoint has probably changed and the data cannot be obtained.',
  NETWORK_ERROR:
    'The registry could not be reached at all (timeout, DNS or connection failure), so nothing is known about this company right now. Retry later. Do NOT report the company as missing or clean on the strength of this.',
};

/**
 * Anything this package raises on purpose.
 *
 * `message` is the bare fact. The code lives in its own field so the server
 * can put it in its own JSON key, and `hint` is the actionable half.
 */
export class ByzdataError extends Error {
  readonly hint: string | undefined;

  constructor(
    message: string,
    readonly code: ByzdataErrorCode,
    readonly source: ByzdataSource,
    hint?: string,
  ) {
    super(message);
    this.name = 'ByzdataError';
    this.hint = hint ?? DEFAULT_HINTS[code];
  }
}

/**
 * A non-2xx answer from one of the registries.
 *
 * Kept as a subclass rather than a separate hierarchy so a caller can catch
 * `ByzdataError` once and still narrow to `HttpError` when it cares about the
 * status (the ARES 400-means-not-in-this-register case does).
 */
export class HttpError extends ByzdataError {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly url: string,
    source: ByzdataSource,
    options?: { code?: ByzdataErrorCode; hint?: string },
  ) {
    super(
      `${source} returned HTTP ${status}${statusText ? ` ${statusText}` : ''}`,
      options?.code ?? mapStatusToCode(status),
      source,
      options?.hint,
    );
    this.name = 'HttpError';
  }
}

/**
 * HTTP status → code.
 *
 * 401 is not special-cased: all three upstreams are unauthenticated public
 * endpoints, so a 401 would mean the endpoint changed rather than that a
 * credential is wrong, and `UPSTREAM_ERROR` says exactly that.
 */
export function mapStatusToCode(status: number): ByzdataErrorCode {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_UNAVAILABLE';
  return 'UPSTREAM_ERROR';
}

export interface UpstreamRequestInit extends RequestInit {
  /** Which registry is being called; appears in the error message. */
  source: ByzdataSource;
}

/**
 * Issue a request and return the response only if the registry answered 2xx.
 *
 * Both the JSON and the HTML paths go through here, which is the whole point:
 * before this existed the scraper threw a bare `Error` and the JSON helper
 * threw an `HttpError`, so half the package produced errors the server could
 * not classify.
 */
export async function upstreamRequest(
  url: string,
  { source, headers, ...init }: UpstreamRequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await safeFetch(url, {
      ...init,
      // The connector host's own policy (`MCP_ALLOW_PRIVATE_NETWORK_TARGETS`)
      // defaults to allowing private targets because internal servers are the
      // primary self-hosted use case, and blocking them here would diverge
      // from it. Link-local and the cloud metadata endpoint stay blocked by
      // `safeFetch` regardless of this flag.
      allowPrivate: true,
      // `safeFetch` does not implement a timeout, so the deadline has to be
      // carried in `init` exactly as it was before the switch. Losing it here
      // is a regression that only shows up against a hanging registry.
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers,
    });
  } catch (error) {
    // Timeouts, DNS failures, connection resets and the SSRF guard all land
    // here. None of them is an answer from the registry, so none of them may
    // be reported as "no such company".
    throw new ByzdataError(
      `${source} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      'NETWORK_ERROR',
      source,
    );
  }

  if (!response.ok) {
    throw new HttpError(response.status, response.statusText, url, source);
  }

  return response;
}

/**
 * Fetch JSON, throwing on every non-2xx status — 404 included.
 *
 * 404 used to be swallowed into `null` for every caller, which made "this IČO
 * is not in the register" and "this endpoint is gone" the same value. Callers
 * for which an absent record is a legitimate answer opt into that explicitly
 * via `fetchJsonOrNull`; callers for which it is not (a search endpoint, say)
 * now get an error instead of an empty result set.
 */
export async function fetchJson<T>(url: string, options: UpstreamRequestInit): Promise<T> {
  const response = await upstreamRequest(url, {
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  });
  return (await response.json()) as T;
}

/**
 * Fetch JSON where a 404 genuinely means "the registry has no such record".
 *
 * Only 404 becomes `null`. Everything else still throws, so an unreachable or
 * failing registry can never be rendered as "company not found".
 */
export async function fetchJsonOrNull<T>(
  url: string,
  options: UpstreamRequestInit,
): Promise<T | null> {
  try {
    return await fetchJson<T>(url, options);
  } catch (error) {
    if (error instanceof HttpError && error.code === 'NOT_FOUND') {
      return null;
    }
    throw error;
  }
}

/** Fetch a page of HTML. Same error shape as the JSON helpers, by design. */
export async function fetchHtml(url: string, options: UpstreamRequestInit): Promise<string> {
  const response = await upstreamRequest(url, {
    ...options,
    headers: { Accept: 'text/html', ...options.headers },
  });
  return response.text();
}
