/**
 * Shared fixtures for the FakturoidClient unit suites.
 *
 * Split out of the original client.test.ts so that every `client.*.test.ts`
 * file builds its client and its mocked fetch exactly the same way.
 *
 * The `vi.mock('node:dns/promises', ...)` call that these suites also share
 * cannot live here: module mocks are hoisted per test file, so each suite
 * repeats it verbatim.
 */

import { vi } from 'vitest';
import { FakturoidClient } from '../src/client.js';

export const mockFetch = vi.fn();

export const BASE = 'https://app.fakturoid.cz/api/v3';
export const SLUG = 'test-slug';
export const CLIENT_ID = 'test-client-id';
export const CLIENT_SECRET = 'test-client-secret';
export const API_KEY = `${SLUG}:${CLIENT_ID}:${CLIENT_SECRET}`;

export const expectedBasicAuth = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;

export function mockResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(data === undefined ? '' : JSON.stringify(data)),
  };
}

export function tokenResponse() {
  return mockResponse({ access_token: 'test-token', expires_in: 7200 });
}

/** Mock a token exchange followed by an API response. */
export function mockTokenAndResponse(data: unknown, status = 200) {
  mockFetch
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(mockResponse(data, status));
}

/** Mock only an API response (token already cached). */
export function mockCachedResponse(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce(mockResponse(data, status));
}

export function url(path: string) {
  return `${BASE}/accounts/${SLUG}/${path}`;
}

/** The shared `beforeEach` body: stub fetch, freeze time, build a fresh client. */
export function createTestClient(): FakturoidClient {
  vi.stubGlobal('fetch', mockFetch);
  vi.useFakeTimers();
  const client = new FakturoidClient(API_KEY);
  vi.clearAllMocks();
  return client;
}

/** The shared `afterEach` body. */
export function restoreGlobals() {
  vi.unstubAllGlobals();
  vi.useRealTimers();
}
