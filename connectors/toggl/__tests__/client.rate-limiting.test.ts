/**
 * Unit tests for TogglClient — rate limiting, request pacing and 429 retries.
 *
 * Tests mock global.fetch to verify HTTP requests are constructed correctly.
 * Shared fixtures live in `client.helpers.ts`.
 */

import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs, TogglApiError } from '../src/client.js';
import {
  API_TOKEN,
  mockFetch,
  mockResponse,
  newClient,
  setupTogglClientTest,
  syntheticHexToken,
} from './client.helpers.js';

describe('TogglClient', () => {
  setupTogglClientTest();

  describe('rate limiting', () => {
    /** Records what the client *would* have waited, without waiting. */
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

    describe('parseRetryAfterMs', () => {
      const NOW = Date.parse('2024-01-15T09:00:00Z');

      it('should read the delay-seconds form', () => {
        expect(parseRetryAfterMs('3', NOW)).toBe(3000);
        expect(parseRetryAfterMs('  12 ', NOW)).toBe(12_000);
        expect(parseRetryAfterMs('0', NOW)).toBe(0);
      });

      it('should read the HTTP-date form', () => {
        // RFC 9110 allows either form and Toggl documents neither, so a client
        // that only understood seconds would silently fall back to guessing.
        expect(parseRetryAfterMs('Mon, 15 Jan 2024 09:00:05 GMT', NOW)).toBe(5000);
      });

      it('should clamp a date already in the past to zero rather than negative', () => {
        expect(parseRetryAfterMs('Mon, 15 Jan 2024 08:59:00 GMT', NOW)).toBe(0);
      });

      it('should return undefined for a missing or unreadable header', () => {
        expect(parseRetryAfterMs(null, NOW)).toBeUndefined();
        expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined();
        expect(parseRetryAfterMs('', NOW)).toBeUndefined();
        expect(parseRetryAfterMs('soon', NOW)).toBeUndefined();
        // Not a whole number of seconds and not a date. `Date.parse` reads
        // "3.5" as a date in the past, which would have been reported as
        // "retry immediately" — the opposite of what a 429 is asking for.
        expect(parseRetryAfterMs('3.5', NOW)).toBeUndefined();
        expect(parseRetryAfterMs('2024-01-15', NOW)).toBeUndefined();
      });
    });

    it('should retry a 429 and return the eventual success', async () => {
      const { sleep, waits } = sleepSpy();
      const c = newClient(API_TOKEN, undefined, undefined, { sleep });
      mockFetch
        .mockResolvedValueOnce(mockResponse('Too many requests', 429))
        .mockResolvedValueOnce(mockResponse([{ id: 1 }]));

      await expect(c.listWorkspaces()).resolves.toEqual([{ id: 1 }]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(waits).toEqual([1000]);
    });

    it('should honour Retry-After when Toggl sends one', async () => {
      const { sleep, waits } = sleepSpy();
      const c = newClient(API_TOKEN, undefined, undefined, { sleep });
      mockFetch
        .mockResolvedValueOnce(mockResponse('slow down', 429, { 'Retry-After': '4' }))
        .mockResolvedValueOnce(mockResponse([]));

      await c.listWorkspaces();
      expect(waits).toEqual([4000]);
    });

    it('should fall back to its own schedule when Retry-After is absent', async () => {
      // Whether Toggl sends the header could not be verified, so the fallback
      // is a real path, not a formality.
      const { sleep, waits } = sleepSpy();
      const c = newClient(API_TOKEN, undefined, undefined, { sleep });
      mockFetch
        .mockResolvedValueOnce(mockResponse('nope', 429))
        .mockResolvedValueOnce(mockResponse('nope', 429))
        .mockResolvedValueOnce(mockResponse([]));

      await c.listWorkspaces();
      expect(waits).toEqual([1000, 2000]);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should give up after the attempt budget and report how long to wait', async () => {
      const { sleep } = sleepSpy();
      const c = newClient(API_TOKEN, undefined, undefined, { sleep });
      mockFetch.mockResolvedValue(mockResponse('Too many requests', 429));

      const error = await c.listWorkspaces().catch((e) => e as TogglApiError);
      expect(error).toBeInstanceOf(TogglApiError);
      expect((error as TogglApiError).code).toBe('RATE_LIMITED');
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect((error as TogglApiError).hint).toContain('retried 2 times');
      expect((error as TogglApiError).hint).toContain('2 seconds');
    });

    it('should not sit through a Retry-After longer than a tool call should block', async () => {
      const { sleep, waits } = sleepSpy();
      const c = newClient(API_TOKEN, undefined, undefined, { sleep });
      mockFetch.mockResolvedValue(mockResponse('come back later', 429, { 'Retry-After': '600' }));

      const error = await c.listWorkspaces().catch((e) => e as TogglApiError);
      // One attempt only: ten minutes is a real answer from Toggl, but blocking
      // on it is a hang, so the number is handed to the caller instead.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(waits).toEqual([]);
      expect((error as TogglApiError).hint).toContain('600 seconds');
    });

    it('should not retry statuses other than 429', async () => {
      const { sleep } = sleepSpy();
      const c = newClient(API_TOKEN, undefined, undefined, { sleep });
      mockFetch.mockResolvedValue(mockResponse('Server error', 500));

      await expect(c.listWorkspaces()).rejects.toThrow(TogglApiError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should survive a 429 whose response carries no headers', async () => {
      // A 429 from an intermediary rather than from Toggl may not have a
      // Headers object at all; losing the retry to a TypeError would turn a
      // throttle into a crash.
      const { sleep } = sleepSpy();
      const c = newClient(API_TOKEN, undefined, undefined, { sleep });
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          text: () => Promise.resolve('slow down'),
        })
        .mockResolvedValueOnce(mockResponse([]));

      await expect(c.listWorkspaces()).resolves.toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should space consecutive requests on the same token', async () => {
      const { sleep, waits } = sleepSpy();
      const clock = 1_000_000;
      const c = newClient(API_TOKEN, undefined, undefined, {
        minRequestIntervalMs: 1000,
        sleep,
        now: () => clock,
      });
      mockFetch.mockResolvedValue(mockResponse([]));

      await c.listWorkspaces();
      await c.listWorkspaces();
      await c.listWorkspaces();

      // The clock is frozen, so every request after the first has to wait out
      // the full interval reserved by its predecessor.
      expect(waits).toEqual([1000, 2000]);
    });

    it('should share pacing between two clients built from the same token', async () => {
      // The connector host caches and recycles upstream instances, so one Toggl token
      // routinely sits behind more than one live client. Pacing per instance
      // would let them each stay politely under a limit they jointly blow.
      const { sleep, waits } = sleepSpy();
      const clock = 2_000_000;
      const options = { minRequestIntervalMs: 1000, sleep, now: () => clock };
      const first = newClient(API_TOKEN, undefined, undefined, options);
      const second = newClient(API_TOKEN, undefined, undefined, options);
      mockFetch.mockResolvedValue(mockResponse([]));

      await first.listWorkspaces();
      await second.listWorkspaces();

      expect(waits).toEqual([1000]);
    });

    it('should not make one token wait on another', async () => {
      const { sleep, waits } = sleepSpy();
      const clock = 3_000_000;
      const options = { minRequestIntervalMs: 1000, sleep, now: () => clock };
      const mine = newClient(API_TOKEN, undefined, undefined, options);
      const theirs = newClient(syntheticHexToken('d'), undefined, undefined, options);
      mockFetch.mockResolvedValue(mockResponse([]));

      await mine.listWorkspaces();
      await theirs.listWorkspaces();

      expect(waits).toEqual([]);
    });

    it('should hold the token back after a 429 even for a request that did not see it', async () => {
      const { sleep, waits } = sleepSpy();
      const clock = 4_000_000;
      const options = { minRequestIntervalMs: 1000, sleep, now: () => clock };
      const c = newClient(API_TOKEN, undefined, undefined, options);
      const other = newClient(API_TOKEN, undefined, undefined, options);
      mockFetch.mockResolvedValue(mockResponse('Too many requests', 429, { 'Retry-After': '5' }));

      await c.listWorkspaces().catch(() => undefined);
      waits.length = 0;
      mockFetch.mockResolvedValue(mockResponse([]));
      await other.listWorkspaces();

      // The refusal was shared, not just survived by the request that hit it.
      // Asserted as a floor rather than an exact figure: the pacing slots the
      // failed attempts reserved add to it, and that arithmetic is not the point.
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeGreaterThanOrEqual(5000);
    });

    it('should refuse a queue wait longer than a tool call may block', async () => {
      // The retry path was bounded and the queue was not, so a 429 asking for
      // ten minutes, or a dozen concurrent calls on one token, produced a wait
      // nothing capped — inside `pace()`, with no hint and no way to fail.
      // A connector cannot assume its caller supplies an outer timeout, so
      // this is the reliable bound.
      const { sleep, waits } = sleepSpy();
      const clock = 5_000_000;
      const c = newClient(API_TOKEN, undefined, undefined, {
        minRequestIntervalMs: 16_000,
        sleep,
        now: () => clock,
      });
      mockFetch.mockResolvedValue(mockResponse([]));

      await c.listWorkspaces();
      const error = await c.listWorkspaces().catch((e) => e as TogglApiError);

      expect(error).toBeInstanceOf(TogglApiError);
      expect((error as TogglApiError).code).toBe('RATE_LIMITED');
      expect((error as TogglApiError).hint).toContain('16 seconds');
      // Refused before the request went out, so it cost nothing upstream.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(waits).toEqual([]);
    });

    it('should not charge the queue for a request it refused', async () => {
      // Claiming a slot for a call that was never sent would push the queue out
      // for the calls still willing to wait, so a burst of refusals would
      // starve exactly the callers that would otherwise have got through.
      const { sleep } = sleepSpy();
      const clock = 6_000_000;
      const c = newClient(API_TOKEN, undefined, undefined, {
        minRequestIntervalMs: 16_000,
        sleep,
        now: () => clock,
      });
      mockFetch.mockResolvedValue(mockResponse([]));

      await c.listWorkspaces();
      const first = await c.listWorkspaces().catch((e) => e as TogglApiError);
      const second = await c.listWorkspaces().catch((e) => e as TogglApiError);

      expect((first as TogglApiError).hint).toContain('16 seconds');
      expect((second as TogglApiError).hint).toContain('16 seconds');
    });

    it('should charge the queue wait against the same budget as the retry waits', async () => {
      // What the caller feels is one stall, whichever half of the client
      // produced it, so queueing and retrying draw on one budget rather than
      // one being bounded and the other free.
      const { sleep, waits } = sleepSpy();
      const clock = 7_000_000;
      const c = newClient(API_TOKEN, undefined, undefined, {
        minRequestIntervalMs: 1000,
        sleep,
        now: () => clock,
      });
      mockFetch.mockResolvedValue(mockResponse([]));
      for (let i = 0; i < 7; i++) await c.listWorkspaces();
      // Seven calls on a frozen clock leave the eighth queued six seconds out.
      expect(waits).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);

      waits.length = 0;
      mockFetch.mockResolvedValue(mockResponse('slow down', 429, { 'Retry-After': '15' }));
      const error = await c.listWorkspaces().catch((e) => e as TogglApiError);

      // Seven seconds of queueing plus a fifteen-second Retry-After overruns the
      // twenty-second budget, so the 429 is reported instead of retried — which
      // it would not have been if the queue wait were free.
      expect(waits).toEqual([7000]);
      expect(mockFetch).toHaveBeenCalledTimes(8);
      expect((error as TogglApiError).code).toBe('RATE_LIMITED');
      expect((error as TogglApiError).hint).toContain('15 seconds');
    });
  });
});
