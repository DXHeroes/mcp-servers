import { callDelay } from './call-context.js';

/**
 * Staying under an upstream rate limit, and answering a 429 without hanging.
 *
 * Every upstream API an MCP package talks to has a rate limit, and the code
 * that respects one is the same everywhere: keep a floor on the gap between
 * requests for a given credential, read `Retry-After` when the API sends one,
 * fall back to a schedule when it does not, and — the part that is easy to get
 * wrong — bound the whole thing, because a tool call is a synchronous step in
 * someone's conversation. Waiting two minutes because the API said so is not
 * resilience, it is a hang. A connector cannot assume its caller supplies an
 * outer timeout, so the package's own budget is the reliable bound.
 *
 * This is opt-in. Nothing paces or retries unless a package constructs a
 * {@link RateLimitPacer} and routes its requests through
 * {@link RateLimitPacer.run}; a package that only reads a public registry may
 * well not need one. What it removes from the package is the mechanism, not
 * the policy: the interval, the budgets and the error the caller finally sees
 * stay the package's own.
 */

/** Total attempts for one request, so `3` means the original plus two retries. */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Waits used when the API answers 429 **without** a `Retry-After` header. */
const DEFAULT_FALLBACK_DELAYS_MS: readonly number[] = [1000, 2000];

/** Longest single wait to sit through, and the total across one call. */
const DEFAULT_MAX_SINGLE_WAIT_MS = 15_000;
const DEFAULT_TOTAL_WAIT_BUDGET_MS = 20_000;

/** Pacing entries idle this long are dropped, so a deleted server stops costing memory. */
const DEFAULT_ENTRY_TTL_MS = 5 * 60 * 1000;

/** Sweeping on every request would be wasted work; the map is tiny in practice. */
const DEFAULT_SWEEP_THRESHOLD = 64;

/** Where a rate-limit wait came from. Never blurred: one is a fact, one is ours. */
export type RateLimitWaitSource = 'retry-after' | 'fallback';

/**
 * The minimum a pacer needs to read off a response. A DOM `Response` satisfies
 * it, and so does the header-less object an intermediary's 429 can produce.
 */
export interface RateLimitedResponse {
  status: number;
  headers?: { get?(name: string): string | null } | undefined;
}

/** What was already tried, for a caller building the error the model will read. */
export interface RateLimitRetryInfo {
  /** Attempts made, the original included. */
  attempts: number;
  /** How long the next attempt would have waited. */
  nextWaitMs: number;
  /** Whether that figure is the API's answer or ours. */
  waitSource: RateLimitWaitSource;
}

/** A request refused before it went out, because its queue slot is too far off. */
export interface RateLimitQueueRefusal {
  /** The pacing key whose slot was too far out. */
  key: string;
  /** How long the caller would have had to wait for it. */
  queueWaitMs: number;
}

/**
 * Default refusal when a package supplies no `onQueueRefused`.
 *
 * Packages should supply one: the caller is a language model, and an error
 * naming the API, the wait and the alternative is worth more than a type it
 * has to guess the meaning of.
 */
export class RateLimitQueueRefusedError extends Error {
  constructor(public readonly queueWaitMs: number) {
    super(
      `The next request slot is ${Math.ceil(queueWaitMs / 1000)} seconds away, which is longer than a tool call may block. The request was not sent.`,
    );
    this.name = 'RateLimitQueueRefusedError';
  }
}

export interface RateLimitPacerOptions {
  /**
   * Minimum gap between two requests sharing a pacing key. Defaults to `0` —
   * no pacing, retry only. Set it to what the API documents; the pacing is a
   * *floor* on the gap, not a burst budget, so a caller issuing ten tool calls
   * back to back is slowed to the limit instead of collecting 429s.
   */
  minRequestIntervalMs?: number;

  /**
   * Groups the process-global pacing slots. Instances sharing a namespace
   * share slots, which is the whole point: the connector host caches and recycles
   * upstream instances, so one credential routinely sits behind more than one
   * live client, and pacing per instance would let them each stay politely
   * under a limit they jointly blow. Give each package its own namespace so
   * two packages cannot collide on a key.
   */
  namespace?: string;

  /** Total attempts per request, retries included. Defaults to 3. */
  maxAttempts?: number;

  /**
   * Waits used when the API answers 429 without a readable `Retry-After`.
   * Indexed by attempt, the last entry repeating. Defaults to `[1000, 2000]`.
   */
  fallbackDelaysMs?: readonly number[];

  /** Longest single wait, queueing included. Defaults to 15 s. */
  maxSingleWaitMs?: number;

  /** Longest total wait across one call, queueing included. Defaults to 20 s. */
  totalWaitBudgetMs?: number;

  /** Statuses treated as "not yet". Defaults to `[429]`. */
  retryStatuses?: readonly number[];

  /** How long an idle pacing slot is kept. Defaults to 5 minutes. */
  entryTtlMs?: number;

  /** Slot count past which a sweep runs. Defaults to 64. */
  sweepThreshold?: number;

  /** Injected so tests can pin the clock. Defaults to `Date.now`. */
  now?: () => number;

  /** Injected so tests do not sleep. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;

  /**
   * Builds the error thrown when a queue wait exceeds what a tool call may
   * block for. The request is not sent, so it costs nothing upstream — say so,
   * and name the wait: the caller is the one entitled to decide whether to
   * come back.
   */
  onQueueRefused?: (refusal: RateLimitQueueRefusal) => Error;
}

interface PacingSlot {
  nextAllowedAt: number;
}

/**
 * Pacing slots are process-global by design — see
 * {@link RateLimitPacerOptions.namespace} — which is exactly what makes them
 * leak across tests, hence {@link resetRateLimitPacing}.
 */
const pacingNamespaces = new Map<string, Map<string, PacingSlot>>();

function slotsFor(namespace: string): Map<string, PacingSlot> {
  const existing = pacingNamespaces.get(namespace);
  if (existing) return existing;
  const created = new Map<string, PacingSlot>();
  pacingNamespaces.set(namespace, created);
  return created;
}

/**
 * Test seam: drops the pacing slots of one namespace, or of all of them.
 *
 * A suite asserting on waits cannot start from whatever an earlier test left
 * behind, and the slots outlive the pacer that created them.
 */
export function resetRateLimitPacing(namespace?: string): void {
  if (namespace === undefined) {
    pacingNamespaces.clear();
    return;
  }
  pacingNamespaces.get(namespace)?.clear();
}

/**
 * Parses a `Retry-After` header into milliseconds.
 *
 * RFC 9110 allows two forms and an API is rarely documented as preferring
 * either, so both are read: `delay-seconds` (`"3"`) and an HTTP-date
 * (`"Wed, 21 Oct 2015 07:28:00 GMT"`). A date already in the past yields `0`,
 * not a negative wait. Anything unparseable returns `undefined` — the caller
 * then falls back to its own schedule rather than trusting a header it could
 * not read.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  now: number,
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // Gated on the weekday prefix that all three date formats RFC 9110 allows
  // begin with, because `Date.parse` is far too willing: it reads "3.5" as a
  // date in the past, which this function would then report as "retry
  // immediately" — the opposite of what a rate limiter is asking for.
  if (!HTTP_DATE_PREFIX_PATTERN.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** Weekday prefix shared by IMF-fixdate, RFC 850 and asctime forms. */
const HTTP_DATE_PREFIX_PATTERN = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i;

/**
 * Paces outbound requests per credential and retries a 429 within budget.
 *
 * Construct one per client and send every request through
 * {@link RateLimitPacer.run}, at the single choke point the package's HTTP
 * calls already go through — pacing applied at call sites is a list nobody
 * keeps complete.
 *
 * A 429 that survives the retries is **returned, not thrown**: only the
 * package knows what its errors look like, and the {@link RateLimitRetryInfo}
 * that comes with it is what lets the resulting message say something the
 * caller has not already done.
 */
export class RateLimitPacer {
  private readonly slots: Map<string, PacingSlot>;
  private readonly minRequestIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly fallbackDelaysMs: readonly number[];
  private readonly maxSingleWaitMs: number;
  private readonly totalWaitBudgetMs: number;
  private readonly retryStatuses: ReadonlySet<number>;
  private readonly entryTtlMs: number;
  private readonly sweepThreshold: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onQueueRefused: (refusal: RateLimitQueueRefusal) => Error;

  constructor(options: RateLimitPacerOptions = {}) {
    this.slots = slotsFor(options.namespace ?? 'default');
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 0;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.fallbackDelaysMs = options.fallbackDelaysMs ?? DEFAULT_FALLBACK_DELAYS_MS;
    this.maxSingleWaitMs = options.maxSingleWaitMs ?? DEFAULT_MAX_SINGLE_WAIT_MS;
    this.totalWaitBudgetMs = options.totalWaitBudgetMs ?? DEFAULT_TOTAL_WAIT_BUDGET_MS;
    this.retryStatuses = new Set(options.retryStatuses ?? [429]);
    this.entryTtlMs = options.entryTtlMs ?? DEFAULT_ENTRY_TTL_MS;
    this.sweepThreshold = options.sweepThreshold ?? DEFAULT_SWEEP_THRESHOLD;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => (ms <= 0 ? Promise.resolve() : callDelay(ms)));
    this.onQueueRefused =
      options.onQueueRefused ?? ((refusal) => new RateLimitQueueRefusedError(refusal.queueWaitMs));
  }

  /**
   * Issues one request under `key`'s pacing slot, retrying a rate-limit status
   * within budget.
   *
   * `key` identifies the thing the limit applies to — an account, a token —
   * and must not *be* the credential: it sits in a long-lived process-wide
   * structure, and a digest identifies the account just as well.
   *
   * Throws only what `onQueueRefused` builds, and only before the request goes
   * out. Anything `send` itself throws propagates untouched.
   */
  async run<T extends RateLimitedResponse>(
    key: string,
    send: () => Promise<T>,
  ): Promise<{ response: T; rateLimit?: RateLimitRetryInfo }> {
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      // Queue waits are charged to the same budget as retry waits: what the
      // caller feels is one stall, whichever half of this produced it.
      waited += await this.pace(key, this.totalWaitBudgetMs - waited);
      const response = await send();
      if (!this.retryStatuses.has(response.status)) {
        return { response };
      }
      const { ms, source } = this.waitFor(response, attempt);
      const outOfAttempts = attempt >= this.maxAttempts;
      const tooLong = ms > this.maxSingleWaitMs;
      const overBudget = waited + ms > this.totalWaitBudgetMs;
      if (outOfAttempts || tooLong || overBudget) {
        // Still deferred: this call gives up, but the next one on this key
        // should not walk straight back into the wall.
        this.defer(key, Math.min(ms, this.maxSingleWaitMs));
        return {
          response,
          rateLimit: { attempts: attempt, nextWaitMs: ms, waitSource: source },
        };
      }
      this.defer(key, ms);
      await this.sleep(ms);
      waited += ms;
    }
  }

  /**
   * Waits until this key's next slot, then claims the one after it.
   *
   * The claim is made *before* the `await`, which is what makes this safe
   * without a lock: JavaScript runs the read-and-write to `nextAllowedAt` to
   * completion before any other request can interleave, so two concurrent
   * calls reserve two different slots rather than both seeing the same one.
   *
   * The queue wait is bounded like every other wait here: `budgetMs` is what
   * is left of this call's total, and a slot further out than that is refused
   * rather than blocked on. Queueing is not a lesser kind of waiting than
   * retrying — from the caller's side it is the same stall.
   *
   * A refusal deliberately does **not** claim the slot. Charging the queue for
   * a request that was never sent would push it out for the calls still
   * willing to wait, so a burst of refusals would starve the calls that would
   * otherwise have succeeded.
   *
   * Returns the milliseconds actually slept, so the caller can keep the total.
   */
  private async pace(key: string, budgetMs: number): Promise<number> {
    if (this.minRequestIntervalMs <= 0) return 0;
    const now = this.now();
    this.sweep(now);
    const state = this.slots.get(key) ?? { nextAllowedAt: 0 };
    const runAt = Math.max(now, state.nextAllowedAt);
    const queueWait = runAt - now;
    const ceiling = Math.min(this.maxSingleWaitMs, Math.max(0, budgetMs));
    if (queueWait > ceiling) {
      throw this.onQueueRefused({ key, queueWaitMs: queueWait });
    }
    this.slots.set(key, state);
    state.nextAllowedAt = runAt + this.minRequestIntervalMs;
    if (queueWait > 0) await this.sleep(queueWait);
    return queueWait;
  }

  /**
   * Pushes this key's next slot out after the API has said "not yet".
   *
   * Without it only the retrying request would back off, while every call that
   * has not yet reached {@link RateLimitPacer.pace} would keep walking into the
   * same 429 — the pacing state is shared precisely so that a refusal is
   * shared too.
   *
   * Note what it does **not** reach: a call already sleeping in `pace()` has
   * claimed its slot and is not moved. Waking it to re-check would mean either
   * a spin or a thundering herd on one shared slot, so the deferral is
   * deliberately limited to calls that have not committed yet; the retry loop
   * is what absorbs the 429 the committed ones may collect.
   */
  private defer(key: string, delayMs: number): void {
    if (this.minRequestIntervalMs <= 0) return;
    const state = this.slots.get(key) ?? { nextAllowedAt: 0 };
    this.slots.set(key, state);
    state.nextAllowedAt = Math.max(state.nextAllowedAt, this.now() + delayMs);
  }

  /**
   * How long to wait before retrying, and on whose authority.
   *
   * `Retry-After` wins when the API sends one — whether it ever does is rarely
   * documented, so the fallback schedule is not a formality. Either way the
   * value is capped by the caller's budget in {@link RateLimitPacer.run}: a
   * header asking for ten minutes is a real answer, but sitting on it inside a
   * tool call is not, and the caller is told the number instead.
   */
  private waitFor(
    response: RateLimitedResponse,
    attempt: number,
  ): { ms: number; source: RateLimitWaitSource } {
    const fromHeader = parseRetryAfterMs(readRetryAfter(response), this.now());
    if (fromHeader !== undefined) return { ms: fromHeader, source: 'retry-after' };
    const index = Math.min(attempt - 1, this.fallbackDelaysMs.length - 1);
    return { ms: this.fallbackDelaysMs[index] ?? 0, source: 'fallback' };
  }

  /** Drops pacing slots nobody has used for a while. */
  private sweep(now: number): void {
    if (this.slots.size < this.sweepThreshold) return;
    for (const [key, state] of this.slots) {
      if (state.nextAllowedAt + this.entryTtlMs < now) this.slots.delete(key);
    }
  }
}

/**
 * Reads the header defensively: a 429 produced by an intermediary rather than
 * by the API may not carry a `Headers` object at all, and losing the retry to a
 * `TypeError` would turn a throttle into a crash.
 */
function readRetryAfter(response: RateLimitedResponse): string | null {
  try {
    return response.headers?.get?.('retry-after') ?? null;
  } catch {
    return null;
  }
}
