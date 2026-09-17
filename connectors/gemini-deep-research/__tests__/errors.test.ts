/**
 * Unit tests for the shared Gemini error classifier.
 *
 * This file exists because the classification used to be two independent lists
 * of substrings — one in `GeminiClient.validateApiKey()`, one in the server's
 * `handleApiError()` — that had already drifted apart. Everything here pins the
 * single replacement, including the cases the old substring matching got wrong.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyGeminiError,
  GeminiApiError,
  type GeminiErrorCode,
  isCredentialProblem,
} from '../src/errors.js';

/**
 * How `@google/genai` actually throws: `ApiError extends Error` with a numeric
 * `status`, and a `message` that is the JSON error body stringified whole.
 */
function apiError(status: number, body: unknown): Error {
  const error = new Error(JSON.stringify(body));
  error.name = 'ApiError';
  return Object.assign(error, { status });
}

describe('classifyGeminiError', () => {
  describe('structured SDK errors (status field)', () => {
    it('should read the numeric status off an ApiError-shaped throw', () => {
      const classified = classifyGeminiError(
        apiError(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }),
      );
      expect(classified.code).toBe('RATE_LIMITED');
      expect(classified.status).toBe(429);
    });

    it('should classify an invalid API key from a 400, not only from a 401', () => {
      // The case the digit matching missed entirely. The Gemini API rejects a
      // bad key with 400 INVALID_ARGUMENT / API_KEY_INVALID, so the old
      // `includes('401') || includes('403')` branch never fired for it and the
      // model was told "Research failed: {json}" instead of "fix the key".
      const classified = classifyGeminiError(
        apiError(400, {
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
            details: [{ reason: 'API_KEY_INVALID' }],
          },
        }),
      );
      expect(classified.code).toBe('INVALID_API_KEY');
      expect(classified.status).toBe(400);
    });

    it('should keep a plain malformed request apart from a bad key', () => {
      const classified = classifyGeminiError(
        apiError(400, { error: { code: 400, status: 'INVALID_ARGUMENT' } }),
      );
      expect(classified.code).toBe('BAD_REQUEST');
    });

    it('should give 403 its own code rather than folding it into the key error', () => {
      // A 403 means the project cannot make this call — enabling the API or
      // fixing a key restriction, not regenerating the key.
      const classified = classifyGeminiError(
        apiError(403, { error: { code: 403, status: 'PERMISSION_DENIED' } }),
      );
      expect(classified.code).toBe('FORBIDDEN');
    });

    it.each<[number, GeminiErrorCode]>([
      [401, 'INVALID_API_KEY'],
      [404, 'NOT_FOUND'],
      [429, 'RATE_LIMITED'],
      [500, 'SERVICE_UNAVAILABLE'],
      [503, 'SERVICE_UNAVAILABLE'],
      [504, 'TIMEOUT'],
    ])('should map status %i to %s', (status, expected) => {
      expect(classifyGeminiError(apiError(status, { error: { code: status } })).code).toBe(
        expected,
      );
    });
  });

  describe('canonical status names', () => {
    it.each<[string, GeminiErrorCode]>([
      ['UNAUTHENTICATED', 'INVALID_API_KEY'],
      ['API_KEY_INVALID', 'INVALID_API_KEY'],
      ['API_KEY_SERVICE_BLOCKED', 'INVALID_API_KEY'],
      ['PERMISSION_DENIED', 'FORBIDDEN'],
      ['RESOURCE_EXHAUSTED', 'RATE_LIMITED'],
      ['DEADLINE_EXCEEDED', 'TIMEOUT'],
      ['UNAVAILABLE', 'SERVICE_UNAVAILABLE'],
      ['NOT_FOUND', 'NOT_FOUND'],
    ])('should classify %s as %s without a status field', (name, expected) => {
      expect(classifyGeminiError(new Error(`got status: ${name}.`)).code).toBe(expected);
    });

    it('should prefer the canonical name over the numeric status', () => {
      // 400 alone is BAD_REQUEST; 400 carrying API_KEY_INVALID is not.
      const classified = classifyGeminiError(
        apiError(400, {
          error: { code: 400, status: 'INVALID_ARGUMENT' },
          reason: 'API_KEY_INVALID',
        }),
      );
      expect(classified.code).toBe('INVALID_API_KEY');
    });
  });

  describe('textual fallback for errors with no status', () => {
    it.each<[string, GeminiErrorCode]>([
      ['401 Unauthorized', 'INVALID_API_KEY'],
      ['429 Too Many Requests', 'RATE_LIMITED'],
      ['404 Not Found', 'NOT_FOUND'],
    ])('should read a leading status code from %s', (message, expected) => {
      expect(classifyGeminiError(new Error(message)).code).toBe(expected);
    });

    it('should read a labelled status code out of a JSON-ish message', () => {
      expect(classifyGeminiError(new Error('failed, {"code":429,"m":"x"}')).code).toBe(
        'RATE_LIMITED',
      );
      expect(classifyGeminiError(new Error('got status: 503. body')).code).toBe(
        'SERVICE_UNAVAILABLE',
      );
      expect(classifyGeminiError(new Error('HTTP 401 from upstream')).code).toBe('INVALID_API_KEY');
    });

    it('should NOT treat an incidental three-digit number as a status code', () => {
      // The regression this anchoring exists for: `message.includes('401')`
      // also fires on a duration, and reported a slow success as a bad key.
      expect(classifyGeminiError(new Error('request took 401 ms')).code).toBe('API_ERROR');
      expect(classifyGeminiError(new Error('read 429 tokens')).code).toBe('API_ERROR');
    });

    it('should classify timeouts by name and by wording', () => {
      const aborted = new Error('The operation was aborted');
      aborted.name = 'TimeoutError';
      expect(classifyGeminiError(aborted).code).toBe('TIMEOUT');
      expect(classifyGeminiError(new Error('Research Timeout after 60 minutes')).code).toBe(
        'TIMEOUT',
      );
      expect(classifyGeminiError(new Error('Research timed out after 60 minutes')).code).toBe(
        'TIMEOUT',
      );
    });

    it('should fall back to API_ERROR for anything unrecognised', () => {
      expect(classifyGeminiError(new Error('ECONNREFUSED')).code).toBe('API_ERROR');
      expect(classifyGeminiError('a bare string').code).toBe('API_ERROR');
      expect(classifyGeminiError(undefined).code).toBe('API_ERROR');
    });
  });

  describe('error shape', () => {
    it('should never prefix the code onto the message', () => {
      // The code is a field, so repeating it in the text
      // produces `RATE_LIMITED: "RATE_LIMITED: ..."` in the tool response.
      for (const message of ['429 Too Many Requests', '401 Unauthorized', 'ECONNREFUSED']) {
        const classified = classifyGeminiError(new Error(message));
        expect(classified.message).toBe(message);
        expect(classified.message.startsWith(`${classified.code}:`)).toBe(false);
      }
    });

    it('should carry an actionable hint for every code except the catch-all', () => {
      expect(classifyGeminiError(new Error('401 Unauthorized')).hint).toBeTruthy();
      expect(classifyGeminiError(new Error('429 x')).hint).toBeTruthy();
      expect(classifyGeminiError(new Error('ECONNREFUSED')).hint).toBeUndefined();
    });

    it('should give a rate-limit hint that does not send the caller after the key', () => {
      // "quota exhausted" and "invalid key" want opposite reactions, which is
      // the reason they are separate codes at all.
      const hint = classifyGeminiError(new Error('429 Too Many Requests')).hint ?? '';
      expect(hint.toLowerCase()).toContain('wait');
      expect(hint.toLowerCase()).not.toContain('configure a valid');
    });

    it('should pass an already-classified error through unchanged', () => {
      const original = new GeminiApiError('boom', 'TIMEOUT');
      expect(classifyGeminiError(original)).toBe(original);
    });

    it('should be an Error, so a throw site can keep throwing it', () => {
      const classified = classifyGeminiError(new Error('401 Unauthorized'));
      expect(classified).toBeInstanceOf(Error);
      expect(classified.name).toBe('GeminiApiError');
    });
  });
});

describe('isCredentialProblem', () => {
  it('should treat both an invalid key and a denied key as a credential problem', () => {
    expect(isCredentialProblem('INVALID_API_KEY')).toBe(true);
    expect(isCredentialProblem('FORBIDDEN')).toBe(true);
  });

  it('should not treat quota, timeouts or outages as a credential problem', () => {
    for (const code of ['RATE_LIMITED', 'TIMEOUT', 'SERVICE_UNAVAILABLE', 'API_ERROR'] as const) {
      expect(isCredentialProblem(code), code).toBe(false);
    }
  });
});
