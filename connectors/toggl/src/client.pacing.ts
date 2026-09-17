/**
 * How fast this client is willing to call Toggl, and how long it will wait.
 *
 * Policy only: the documented ~1 req/sec ceiling, the retry schedule, the
 * bounds on how long a tool call may block, and the shared pacing namespace.
 * `RateLimitPacer` (core) supplies the mechanism that applies them.
 */

import { resetRateLimitPacing } from '@dxheroes/mcp-kit';

// ── Rate limiting ────────────────────────────────────────────────────
//
// Toggl documents roughly **one request per second per IP per API token**, and
// independent clients report a much tighter ceiling on the `/me/*` endpoints
// (around 30 requests per hour). Before this, a 429 was mapped straight to
// `RATE_LIMITED` and thrown: correct, but it made the caller carry a retry the
// client is in a far better position to do, and it made every tool that needs
// more than one upstream request a trap.

/**
 * Minimum spacing between two requests carrying the same API token.
 *
 * Matches the documented ~1 req/sec. The pacing is a *floor* on the gap, not a
 * burst budget: it never gets ahead of itself, so a caller issuing ten tool
 * calls back to back is slowed to the limit instead of collecting 429s.
 */
export const MIN_REQUEST_INTERVAL_MS = 1000;

/** Total attempts for one request, so `3` means the original plus two retries. */
export const RATE_LIMIT_MAX_ATTEMPTS = 3;

/**
 * Waits used when Toggl answers 429 **without** a `Retry-After` header.
 *
 * Whether Toggl sends the header at all is not something we could verify — the
 * two independent Toggl clients that handle 429 both read it defensively
 * ("when present"), so both paths are implemented and neither is assumed.
 */
export const RATE_LIMIT_FALLBACK_DELAYS_MS: readonly number[] = [1000, 2000];

/**
 * Longest single wait we will sit through, and the total across one call.
 *
 * A tool call is a synchronous step in someone's conversation: waiting two
 * minutes because Toggl said so is not resilience, it is a hang. Past the
 * budget the 429 is surfaced with a hint naming the wait, so the *caller*
 * decides whether to come back — which is the decision it is allowed to make
 * and we are not.
 *
 * Both bounds cover **every** wait this client performs, queueing included —
 * not just the retry sleeps. That was a real gap: a 429 asking for ten minutes
 * was correctly refused by the retry loop and then pushed the token's pacing
 * slot out by 15 seconds anyway, so the *next* call queued for the full 15
 * seconds with no budget, no hint and no way to fail. Twelve concurrent calls
 * on one token did the same thing for eleven seconds, thirty for twenty-nine.
 * A connector cannot assume its caller supplies an outer timeout, so this pair
 * bounds how long a tool call can block.
 */
export const RATE_LIMIT_MAX_SINGLE_WAIT_MS = 15_000;
export const RATE_LIMIT_TOTAL_WAIT_BUDGET_MS = 20_000;

/**
 * Formats a wait for a hint: whole seconds, because a millisecond figure reads
 * like a precision Toggl never promised.
 */
export function describeWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

/**
 * Groups this package's pacing slots, which are shared by **every** client
 * instance in this process.
 *
 * Sharing is the point, not an implementation detail: the same process can
 * hold more than one live `TogglClient` for one token. Pacing per instance
 * would let those clients run in parallel and each stay politely under a limit
 * they are jointly blowing.
 *
 * What this does **not** cover, and cannot: Toggl counts per IP *and* per
 * token, and several connector processes can share one egress IP. Two
 * processes each pace themselves correctly and still arrive at twice the rate.
 * Coordinating that needs shared state the package has no access to, so the
 * retry is what catches it.
 */
export const TOGGL_PACING_NAMESPACE = 'toggl';

/**
 * Test seam. The pacing slots are process-global by design, which is exactly
 * what makes them leak across tests — a suite asserting on waits cannot start
 * from whatever an earlier test left behind.
 */
export function __resetTogglPacingForTests(): void {
  resetRateLimitPacing(TOGGL_PACING_NAMESPACE);
}
