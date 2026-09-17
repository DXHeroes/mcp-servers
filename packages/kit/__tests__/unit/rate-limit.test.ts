import { afterEach, describe, expect, it } from 'vitest';
import {
  parseRetryAfterMs,
  type RateLimitedResponse,
  RateLimitPacer,
  RateLimitQueueRefusedError,
  resetRateLimitPacing,
} from '../../src/utils/rate-limit.js';

/** Records what the pacer *would* have waited, without waiting. */
function sleepSpy() {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

function response(status: number, retryAfter?: string): RateLimitedResponse {
  return {
    status,
    headers: { get: (name) => (name === 'retry-after' ? (retryAfter ?? null) : null) },
  };
}

/** Every test uses its own namespace, but the slots outlive the pacer. */
afterEach(() => resetRateLimitPacing());

describe('parseRetryAfterMs', () => {
  const NOW = Date.parse('2024-01-15T09:00:00Z');

  it('should read delay-seconds', () => {
    expect(parseRetryAfterMs('3', NOW)).toBe(3000);
    expect(parseRetryAfterMs('  12 ', NOW)).toBe(12_000);
    expect(parseRetryAfterMs('0', NOW)).toBe(0);
  });

  it('should read an HTTP-date', () => {
    expect(parseRetryAfterMs('Mon, 15 Jan 2024 09:00:05 GMT', NOW)).toBe(5000);
  });

  it('should not report a past HTTP-date as a negative wait', () => {
    expect(parseRetryAfterMs('Mon, 15 Jan 2024 08:59:00 GMT', NOW)).toBe(0);
  });

  it('should return undefined for a header it cannot read', () => {
    expect(parseRetryAfterMs(null, NOW)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfterMs('', NOW)).toBeUndefined();
    expect(parseRetryAfterMs('soon', NOW)).toBeUndefined();
  });

  it('should refuse what Date.parse would happily misread', () => {
    // `Date.parse('3.5')` is a date in the past, which would surface as "retry
    // immediately" — the opposite of what a rate limiter is asking for.
    expect(parseRetryAfterMs('3.5', NOW)).toBeUndefined();
    expect(parseRetryAfterMs('2024-01-15', NOW)).toBeUndefined();
  });
});

describe('RateLimitPacer', () => {
  describe('retrying', () => {
    it('should not wait or retry when the response is not rate-limited', () => {
      const { sleep, waits } = sleepSpy();
      const pacer = new RateLimitPacer({ namespace: 'ok', sleep });
      let calls = 0;

      return pacer
        .run('key', () => {
          calls++;
          return Promise.resolve(response(200));
        })
        .then((result) => {
          expect(result.response.status).toBe(200);
          expect(result.rateLimit).toBeUndefined();
          expect(calls).toBe(1);
          expect(waits).toEqual([]);
        });
    });

    it('should not retry a status outside the retry set', async () => {
      const { sleep } = sleepSpy();
      const pacer = new RateLimitPacer({ namespace: 'other-status', sleep });
      let calls = 0;

      await pacer.run('key', () => {
        calls++;
        return Promise.resolve(response(500));
      });

      expect(calls).toBe(1);
    });

    it('should retry the statuses it was told to', async () => {
      const { sleep, waits } = sleepSpy();
      const pacer = new RateLimitPacer({
        namespace: 'custom-status',
        retryStatuses: [503],
        sleep,
      });
      const statuses = [503, 200];

      const result = await pacer.run('key', () =>
        Promise.resolve(response(statuses.shift() as number)),
      );

      expect(result.response.status).toBe(200);
      expect(waits).toEqual([1000]);
    });

    it('should retry a 429 and return the eventual success', async () => {
      const { sleep, waits } = sleepSpy();
      const pacer = new RateLimitPacer({ namespace: 'retry', sleep });
      const statuses = [429, 200];

      const result = await pacer.run('key', () =>
        Promise.resolve(response(statuses.shift() as number)),
      );

      expect(result.response.status).toBe(200);
      expect(result.rateLimit).toBeUndefined();
      expect(waits).toEqual([1000]);
    });

    it('should honour Retry-After over its own schedule', async () => {
      const { sleep, waits } = sleepSpy();
      const pacer = new RateLimitPacer({ namespace: 'header', sleep });
      const responses = [response(429, '4'), response(200)];

      await pacer.run('key', () => Promise.resolve(responses.shift() as RateLimitedResponse));

      expect(waits).toEqual([4000]);
    });

    it('should read an HTTP-date Retry-After', async () => {
      const now = Date.parse('2024-01-15T09:00:00Z');
      const { sleep, waits } = sleepSpy();
      const pacer = new RateLimitPacer({ namespace: 'header-date', sleep, now: () => now });
      const responses = [response(429, 'Mon, 15 Jan 2024 09:00:07 GMT'), response(200)];

      await pacer.run('key', () => Promise.resolve(responses.shift() as RateLimitedResponse));

      expect(waits).toEqual([7000]);
    });

    it('should fall back to its own schedule when the header is absent', async () => {
      // Whether a given API sends the header is rarely documented, so the
      // fallback is a real path rather than a formality.
      const { sleep, waits } = sleepSpy();
      const pacer = new RateLimitPacer({ namespace: 'fallback', sleep });
      const statuses = [429, 429, 200];
      let calls = 0;

      await pacer.run('key', () => {
        calls++;
        return Promise.resolve(response(statuses.shift() as number));
      });

      expect(waits).toEqual([1000, 2000]);
      expect(calls).toBe(3);
    });

    it('should give up after the attempt budget and report what it tried', async () => {
      const { sleep } = sleepSpy();
      const pacer = new RateLimitPacer({ namespace: 'attempts', sleep });
      let calls = 0;

      const result = await pacer.run('key', () => {
        calls++;
        return Promise.resolve(response(429));
      });

      expect(calls).toBe(3);
      expect(result.response.status).toBe(429);
      expect(result.rateLimit).toEqual({ attempts: 3, nextWaitMs: 2000, waitSource: 'fallback' });
    });

    it('should not sit through a wait longer than a tool call may block', async () => {
      const { sleep, waits } = sleepSpy();
      const pacer = new RateLimitPacer({ namespace: 'too-long', sleep });
      let calls = 0;

      const result = await pacer.run('key', () => {
        calls++;
        return Promise.resolve(response(429, '600'));
      });

      // Ten minutes is a real answer, but blocking on it is a hang: the figure
      // goes to the caller instead, who is the one entitled to come back later.
      expect(calls).toBe(1);
      expect(waits).toEqual([]);
      expect(result.rateLimit).toEqual({
        attempts: 1,
        nextWaitMs: 600_000,
        waitSource: 'retry-after',
      });
    });

    it('should stop once the total budget would be overrun', async () => {
      const { sleep, waits } = sleepSpy();
      const pacer = new RateLimitPacer({
        namespace: 'budget',
        maxAttempts: 5,
        maxSingleWaitMs: 15_000,
        totalWaitBudgetMs: 20_000,
        sleep,
      });
      let calls = 0;

      const result = await pacer.run('key', () => {
        calls++;
        return Promise.resolve(response(429, '15'));
      });

      // Two fifteen-second waits do not fit in twenty seconds, so the second
      // 429 is reported rather than slept on — attempts were still available.
      expect(waits).toEqual([15_000]);
      expect(calls).toBe(2);
      expect(result.rateLimit?.attempts).toBe(2);
    });

    it('should survive a rate-limited response that carries no headers', async () => {
      // A 429 produced by an intermediary rather than by the API may not carry
      // a Headers object at all; losing the retry to a TypeError would turn a
      // throttle into a crash.
      const { sleep, waits } = sleepSpy();
      const pacer = new RateLimitPacer({ namespace: 'no-headers', sleep });
      const responses: RateLimitedResponse[] = [{ status: 429 }, { status: 200 }];

      const result = await pacer.run('key', () =>
        Promise.resolve(responses.shift() as RateLimitedResponse),
      );

      expect(result.response.status).toBe(200);
      expect(waits).toEqual([1000]);
    });

    it('should survive a headers object that throws', async () => {
      const { sleep, waits } = sleepSpy();
      const pacer = new RateLimitPacer({ namespace: 'throwing-headers', sleep });
      const responses: RateLimitedResponse[] = [
        {
          status: 429,
          headers: {
            get: () => {
              throw new TypeError('no headers here');
            },
          },
        },
        { status: 200 },
      ];

      const result = await pacer.run('key', () =>
        Promise.resolve(responses.shift() as RateLimitedResponse),
      );

      expect(result.response.status).toBe(200);
      expect(waits).toEqual([1000]);
    });
  });

  describe('pacing', () => {
    it('should not pace at all by default', async () => {
      const { sleep, waits } = sleepSpy();
      const pacer = new RateLimitPacer({ namespace: 'unpaced', sleep, now: () => 1_000_000 });

      await pacer.run('key', () => Promise.resolve(response(200)));
      await pacer.run('key', () => Promise.resolve(response(200)));

      expect(waits).toEqual([]);
    });

    it('should space consecutive requests on the same key', async () => {
      const { sleep, waits } = sleepSpy();
      const pacer = new RateLimitPacer({
        namespace: 'spacing',
        minRequestIntervalMs: 1000,
        sleep,
        now: () => 1_000_000,
      });

      await pacer.run('key', () => Promise.resolve(response(200)));
      await pacer.run('key', () => Promise.resolve(response(200)));
      await pacer.run('key', () => Promise.resolve(response(200)));

      // The clock is frozen, so every request after the first waits out the
      // full interval reserved by its predecessor.
      expect(waits).toEqual([1000, 2000]);
    });

    it('should not make one key wait on another', async () => {
      const { sleep, waits } = sleepSpy();
      const pacer = new RateLimitPacer({
        namespace: 'two-keys',
        minRequestIntervalMs: 1000,
        sleep,
        now: () => 2_000_000,
      });

      await pacer.run('mine', () => Promise.resolve(response(200)));
      await pacer.run('theirs', () => Promise.resolve(response(200)));

      expect(waits).toEqual([]);
    });

    it('should share slots between two pacers in one namespace', async () => {
      // The connector host caches and recycles upstream instances, so one credential
      // routinely sits behind more than one live client. Pacing per instance
      // would let them each stay politely under a limit they jointly blow.
      const { sleep, waits } = sleepSpy();
      const options = { namespace: 'shared', minRequestIntervalMs: 1000, sleep, now: () => 3e6 };
      const first = new RateLimitPacer(options);
      const second = new RateLimitPacer(options);

      await first.run('key', () => Promise.resolve(response(200)));
      await second.run('key', () => Promise.resolve(response(200)));

      expect(waits).toEqual([1000]);
    });

    it('should keep namespaces apart', async () => {
      const { sleep, waits } = sleepSpy();
      const base = { minRequestIntervalMs: 1000, sleep, now: () => 4e6 };
      const mine = new RateLimitPacer({ ...base, namespace: 'pkg-a' });
      const theirs = new RateLimitPacer({ ...base, namespace: 'pkg-b' });

      await mine.run('key', () => Promise.resolve(response(200)));
      await theirs.run('key', () => Promise.resolve(response(200)));

      expect(waits).toEqual([]);
    });

    it('should hold the key back after a 429 even for a request that did not see it', async () => {
      const { sleep, waits } = sleepSpy();
      const options = { namespace: 'deferred', minRequestIntervalMs: 1000, sleep, now: () => 5e6 };
      const first = new RateLimitPacer(options);
      const second = new RateLimitPacer(options);

      // Runs out of budget and refuses its own last attempt; that is not the
      // point here — what the *next* caller inherits is.
      await first.run('key', () => Promise.resolve(response(429, '5'))).catch(() => undefined);
      waits.length = 0;
      await second.run('key', () => Promise.resolve(response(200)));

      // The refusal is shared, not merely survived by the request that hit it.
      // A floor rather than an exact figure: the slots the failed attempts
      // reserved add to it, and that arithmetic is not the point.
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeGreaterThanOrEqual(5000);
    });

    it('should charge the queue wait against the same budget as the retry waits', async () => {
      const { sleep, waits } = sleepSpy();
      const pacer = new RateLimitPacer({
        namespace: 'one-budget',
        minRequestIntervalMs: 1000,
        sleep,
        now: () => 6e6,
      });
      for (let i = 0; i < 7; i++) {
        await pacer.run('key', () => Promise.resolve(response(200)));
      }
      expect(waits).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);

      waits.length = 0;
      let calls = 0;
      const result = await pacer.run('key', () => {
        calls++;
        return Promise.resolve(response(429, '15'));
      });

      // Seven seconds of queueing plus a fifteen-second Retry-After overruns
      // the twenty-second budget, so the 429 is reported instead of retried —
      // which it would not have been if the queue wait were free.
      expect(waits).toEqual([7000]);
      expect(calls).toBe(1);
      expect(result.rateLimit?.nextWaitMs).toBe(15_000);
    });
  });

  describe('queue refusal', () => {
    const refusing = (namespace: string, onQueueRefused?: (r: { queueWaitMs: number }) => Error) =>
      new RateLimitPacer({
        namespace,
        minRequestIntervalMs: 16_000,
        sleep: () => Promise.resolve(),
        now: () => 7e6,
        ...(onQueueRefused ? { onQueueRefused } : {}),
      });

    it('should refuse a queue wait longer than a tool call may block', async () => {
      const pacer = refusing('refuse');
      let calls = 0;
      const send = () => {
        calls++;
        return Promise.resolve(response(200));
      };

      await pacer.run('key', send);
      const error = await pacer.run('key', send).catch((e) => e as Error);

      expect(error).toBeInstanceOf(RateLimitQueueRefusedError);
      expect((error as RateLimitQueueRefusedError).queueWaitMs).toBe(16_000);
      // Refused before the request went out, so it cost nothing upstream.
      expect(calls).toBe(1);
    });

    it('should let the package word the refusal', async () => {
      const pacer = refusing(
        'refuse-custom',
        ({ queueWaitMs }) => new Error(`come back in ${queueWaitMs / 1000}s`),
      );
      const send = () => Promise.resolve(response(200));

      await pacer.run('key', send);

      await expect(pacer.run('key', send)).rejects.toThrow('come back in 16s');
    });

    it('should not charge the queue for a request it refused', async () => {
      // Claiming a slot for a call that was never sent would push the queue out
      // for the calls still willing to wait, so a burst of refusals would
      // starve exactly the callers that would otherwise have got through.
      const pacer = refusing('refuse-free');
      const send = () => Promise.resolve(response(200));

      await pacer.run('key', send);
      const first = await pacer.run('key', send).catch((e) => e as RateLimitQueueRefusedError);
      const second = await pacer.run('key', send).catch((e) => e as RateLimitQueueRefusedError);

      expect((first as RateLimitQueueRefusedError).queueWaitMs).toBe(16_000);
      expect((second as RateLimitQueueRefusedError).queueWaitMs).toBe(16_000);
    });
  });

  describe('resetRateLimitPacing', () => {
    it('should drop the slots of one namespace and leave the others', async () => {
      const { sleep, waits } = sleepSpy();
      const base = { minRequestIntervalMs: 1000, sleep, now: () => 8e6 };
      const mine = new RateLimitPacer({ ...base, namespace: 'reset-mine' });
      const theirs = new RateLimitPacer({ ...base, namespace: 'reset-theirs' });
      const send = () => Promise.resolve(response(200));

      await mine.run('key', send);
      await theirs.run('key', send);
      resetRateLimitPacing('reset-mine');
      waits.length = 0;

      await mine.run('key', send);
      await theirs.run('key', send);

      expect(waits).toEqual([1000]);
    });
  });
});
