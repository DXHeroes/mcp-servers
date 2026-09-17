/**
 * Shared setup for the MerkClient unit suites.
 *
 * Deliberately not named `*.test.ts` so Vitest does not collect it as a suite.
 * Every `client.*.test.ts` file imports the same fetch double and lifecycle
 * bodies from here, so the setup cannot drift between them.
 */

import { vi } from 'vitest';
import { MerkClient } from '../src/client.js';

/** The single `fetch` double every client suite installs and asserts against. */
export const mockFetch = vi.fn();

/** The API key the client under test is constructed with. */
export const TEST_API_KEY = 'test-api-key-123';

/**
 * The shared `beforeEach` body: stub `fetch`, build a fresh client, clear any
 * calls recorded by a previous test.
 */
export function beginClientTest(): MerkClient {
  vi.stubGlobal('fetch', mockFetch);
  const client = new MerkClient(TEST_API_KEY);
  vi.clearAllMocks();
  return client;
}

/** The matching `afterEach` body. */
export function endClientTest(): void {
  vi.unstubAllGlobals();
}

// Helper to create a mock Response
export function mockResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}
