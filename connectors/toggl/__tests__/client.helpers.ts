/**
 * Shared fixtures for the TogglClient unit tests.
 *
 * The suite was split across several `client.*.test.ts` files to stay under
 * Biome's per-file and per-function line limits; everything that was set up
 * once for the whole suite lives here so the halves cannot drift apart.
 *
 * This file is deliberately not named `*.test.ts` — Vitest would otherwise
 * pick it up as a suite of its own and report it as having no tests.
 */

import { afterEach, beforeEach, vi } from 'vitest';
import { __resetTogglPacingForTests, TogglClient, type TogglClientOptions } from '../src/client.js';

export const mockFetch = vi.fn();

/**
 * A realistically shaped Toggl API token: 32 hex characters.
 *
 * Value-based scrubbing only applies to a token that looks like one, so a
 * made-up string like `test-token` would exercise the reduced mode instead of
 * the real one. The reduced mode has its own tests below.
 */
export function syntheticHexToken(digit: string): string {
  if (!/^[0-9a-f]$/i.test(digit)) throw new Error('Synthetic token digit must be hexadecimal');
  return digit.repeat(32);
}

export const API_TOKEN = syntheticHexToken('a');

export const expectedAuth = `Basic ${Buffer.from(`${API_TOKEN}:api_token`).toString('base64')}`;

/**
 * Builds a client that does not pace itself.
 *
 * The real client spaces requests a second apart per token, which is correct
 * against Toggl and unusable in a suite that issues hundreds of them. Every
 * test that is not *about* pacing opts out; the ones that are set their own
 * interval and inject a sleep, so nothing here waits on a real clock.
 */
export function newClient(
  token = API_TOKEN,
  trackBaseUrl?: string,
  reportsBaseUrl?: string,
  options: TogglClientOptions = {},
): TogglClient {
  return new TogglClient(token, trackBaseUrl, reportsBaseUrl, {
    minRequestIntervalMs: 0,
    // Retries of a 429 would otherwise sit on the real fallback schedule
    // (1s, then 2s). Tests that care about the schedule inject their own spy.
    sleep: () => Promise.resolve(),
    ...options,
  });
}

export function mockResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    // A real Response always carries a Headers object, and the 429 path reads
    // `Retry-After` off it. Omitting it here made the mock the one shape the
    // client never sees in production.
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(data === undefined ? '' : JSON.stringify(data)),
  };
}

/**
 * Installs the per-test setup every TogglClient suite shares.
 *
 * `receiveClient` hands the freshly built client back to the calling file's
 * own `client` binding, so the test bodies read exactly as they did when they
 * all lived in one file.
 */
export function setupTogglClientTest(receiveClient?: (client: TogglClient) => void): void {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    // The pacing map is process-global on purpose, so it has to be cleared
    // between tests or one test's reserved slot delays the next one's request.
    __resetTogglPacingForTests();
    receiveClient?.(newClient());
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
