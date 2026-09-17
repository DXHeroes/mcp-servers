/**
 * Shared setup for the GeminiClient unit tests.
 *
 * The `vi.mock('@google/genai', ...)` call itself is hoisted per module and so
 * has to be repeated in each test file; it pulls these mock functions in via a
 * dynamic import so every file drives the same instances.
 */

import { type Mock, vi } from 'vitest';

// Mock functions at module level so they persist across instances
export const mockInteractionsCreate: Mock = vi.fn();
export const mockInteractionsGet: Mock = vi.fn();
export const mockModelsList: Mock = vi.fn();

// Helper to get the mock functions
export function getMocks() {
  return {
    interactions: {
      create: mockInteractionsCreate,
      get: mockInteractionsGet,
    },
    models: {
      list: mockModelsList,
    },
  };
}
