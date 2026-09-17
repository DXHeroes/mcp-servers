/**
 * Unit tests for the shared HTTP layer.
 *
 * Three things are pinned here, in order of how badly they bite when wrong:
 * the 404 → `null` conflation, the timeout surviving the move to `safeFetch`,
 * and the single error shape all three upstreams now fail into.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ByzdataError as ByzdataErrorType } from '../src/utils/http.js';
import { failureResponse, jsonResponse } from './helpers.js';

const mockSafeFetch = vi.fn();

vi.mock('@dxheroes/mcp-kit', async (importOriginal) => {
  const original = await importOriginal<typeof import('@dxheroes/mcp-kit')>();
  return { ...original, safeFetch: mockSafeFetch };
});

const {
  ByzdataError,
  fetchHtml,
  fetchJson,
  fetchJsonOrNull,
  HttpError,
  mapStatusToCode,
  REQUEST_TIMEOUT_MS,
} = await import('../src/utils/http.js');

/** Await a rejection and hand back the error already narrowed. */
async function caught(promise: Promise<unknown>): Promise<ByzdataErrorType> {
  try {
    await promise;
  } catch (error) {
    return error as ByzdataErrorType;
  }
  throw new Error('expected the request to reject, but it resolved');
}

const URL_UNDER_TEST = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/1';

describe('mapStatusToCode', () => {
  it.each([
    [400, 'BAD_REQUEST'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'UPSTREAM_UNAVAILABLE'],
    [503, 'UPSTREAM_UNAVAILABLE'],
    [418, 'UPSTREAM_ERROR'],
  ])('should map %i to %s', (status, expected) => {
    expect(mapStatusToCode(status)).toBe(expected);
  });

  it('should not invent a credential code for 401', () => {
    // All three upstreams are unauthenticated public endpoints, so a 401 means
    // the endpoint changed — not that a token needs fixing.
    expect(mapStatusToCode(401)).toBe('UPSTREAM_ERROR');
  });
});

describe('safeFetch wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeFetch.mockResolvedValue(jsonResponse({ ok: true }));
  });

  it('should route requests through safeFetch, not bare fetch', async () => {
    await fetchJson(URL_UNDER_TEST, { source: 'ARES' });
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockSafeFetch.mock.calls[0]?.[0]).toBe(URL_UNDER_TEST);
  });

  it('should allow private targets, matching the connector host default', async () => {
    // `MCP_ALLOW_PRIVATE_NETWORK_TARGETS` defaults to true; blocking private
    // targets here would diverge from it. Link-local and the metadata endpoint
    // stay blocked inside safeFetch regardless of this flag.
    await fetchJson(URL_UNDER_TEST, { source: 'ARES' });
    expect(mockSafeFetch.mock.calls[0]?.[1]).toMatchObject({ allowPrivate: true });
  });

  it('should keep the 15s deadline that safeFetch does not provide', async () => {
    // safeFetch implements no timeout of its own. Dropping the signal here is
    // a regression that only shows up against a hanging registry, which is why
    // it is asserted on the call arguments rather than trusted.
    await fetchJson(URL_UNDER_TEST, { source: 'ARES' });
    const init = mockSafeFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it('should keep the deadline on the HTML path too', async () => {
    mockSafeFetch.mockResolvedValue(jsonResponse('<html></html>'));
    await fetchHtml('https://or.justice.cz/ias/ui/rejstrik', { source: 'justice.cz' });
    const init = mockSafeFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('should let an explicit signal win over the default deadline', async () => {
    const controller = new AbortController();
    await fetchJson(URL_UNDER_TEST, { source: 'ARES', signal: controller.signal });
    const init = mockSafeFetch.mock.calls[0]?.[1];
    expect((init as RequestInit).signal).toBe(controller.signal);
  });

  it('should merge caller headers with the defaults', async () => {
    await fetchJson(URL_UNDER_TEST, {
      source: 'ARES',
      headers: { 'Content-Type': 'application/json' },
    });
    const init = mockSafeFetch.mock.calls[0]?.[1];
    expect((init as RequestInit).headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
  });
});

describe('fetchJson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return the parsed body on 200', async () => {
    mockSafeFetch.mockResolvedValue(jsonResponse({ ico: '1' }));
    await expect(fetchJson(URL_UNDER_TEST, { source: 'ARES' })).resolves.toEqual({ ico: '1' });
  });

  it('should throw on 404 rather than returning null', async () => {
    // The behaviour this whole change exists for. A caller that wants "absent
    // record" has to say so via fetchJsonOrNull; nobody gets it by accident.
    mockSafeFetch.mockResolvedValue(failureResponse(404, 'Not Found'));
    await expect(fetchJson(URL_UNDER_TEST, { source: 'ARES' })).rejects.toBeInstanceOf(HttpError);
  });

  it.each([
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [503, 'UPSTREAM_UNAVAILABLE'],
  ])('should attach code %s for status %i', async (status, code) => {
    mockSafeFetch.mockResolvedValue(failureResponse(status));
    await expect(fetchJson(URL_UNDER_TEST, { source: 'ARES' })).rejects.toMatchObject({
      code,
      status,
    });
  });

  it('should name the source in the message and keep the code out of it', async () => {
    // The code travels in its own field. Prefixing it onto the message
    // produced `UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE: ..."`.
    mockSafeFetch.mockResolvedValue(failureResponse(503, 'Service Unavailable'));
    const error = await caught(fetchJson(URL_UNDER_TEST, { source: 'ARES' }));
    expect(error.message).toBe('ARES returned HTTP 503 Service Unavailable');
    expect(error.message).not.toContain('UPSTREAM_UNAVAILABLE');
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('should carry a hint that warns against reporting the company as missing', async () => {
    mockSafeFetch.mockResolvedValue(failureResponse(503));
    const error = await caught(fetchJson(URL_UNDER_TEST, { source: 'ARES' }));
    expect(error.hint).toContain('Do NOT report the company as missing');
  });

  it('should turn a transport failure into NETWORK_ERROR, not a missing record', async () => {
    mockSafeFetch.mockRejectedValue(new Error('The operation was aborted'));
    const error = await caught(fetchJson(URL_UNDER_TEST, { source: 'ARES' }));
    expect(error).toBeInstanceOf(ByzdataError);
    expect(error).not.toBeInstanceOf(HttpError);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toContain('ARES could not be reached');
  });

  it('should surface a blocked SSRF target as a reachability failure', async () => {
    mockSafeFetch.mockRejectedValue(
      new Error('Request blocked: "169.254.169.254" resolves to a private address'),
    );
    const error = await caught(fetchJson(URL_UNDER_TEST, { source: 'ARES' }));
    expect(error.code).toBe('NETWORK_ERROR');
  });
});

describe('fetchJsonOrNull', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null for a 404 and only for a 404', async () => {
    mockSafeFetch.mockResolvedValue(failureResponse(404));
    await expect(fetchJsonOrNull(URL_UNDER_TEST, { source: 'ARES' })).resolves.toBeNull();
  });

  it.each([500, 503, 429, 403])('should still throw on %i', async (status) => {
    mockSafeFetch.mockResolvedValue(failureResponse(status));
    await expect(fetchJsonOrNull(URL_UNDER_TEST, { source: 'ARES' })).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it('should still throw when the registry cannot be reached at all', async () => {
    mockSafeFetch.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(fetchJsonOrNull(URL_UNDER_TEST, { source: 'ARES' })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });
});

describe('fetchHtml', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fail in the same shape as the JSON path', async () => {
    // The scraper used to throw a bare `new Error("HTTP 503 for <url>")`, which
    // the server could only report as a generic tool error. Both paths now
    // produce an HttpError with a code.
    mockSafeFetch.mockResolvedValue(failureResponse(503, 'Service Unavailable'));
    const htmlError = await caught(fetchHtml('https://or.justice.cz/x', { source: 'justice.cz' }));
    const jsonError = await caught(fetchJson(URL_UNDER_TEST, { source: 'ARES' }));

    expect(htmlError).toBeInstanceOf(HttpError);
    expect(htmlError.code).toBe(jsonError.code);
    expect(htmlError.hint).toBe(jsonError.hint);
    expect(htmlError.message).toBe('justice.cz returned HTTP 503 Service Unavailable');
  });
});
