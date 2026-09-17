/**
 * Unit tests for ByzdataMcpServer.
 *
 * Scoped to what this change touches: the MCP annotations, the coded error
 * responses, and the "absent record vs. unavailable registry" distinction that
 * a registry service has no business getting wrong. Rendering of the nine
 * happy paths is deliberately not covered here — that is a separate piece of
 * work and pretending otherwise with a thin smoke test would be worse than
 * leaving the gap visible.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARES_RZP_URL,
  ARES_SEARCH_URL,
  ARES_SUBJECT_URL,
  ARES_VR_URL,
  aresSubject,
  aresVrWithDirector,
  failureResponse,
  htmlResponse,
  ISIR_URL,
  isError,
  JUSTICE_URL,
  jsonResponse,
  parseError,
  type Route,
  routeRequests,
  textOf,
} from './helpers.js';

const mockSafeFetch = vi.fn();

vi.mock('@dxheroes/mcp-kit', async (importOriginal) => {
  const original = await importOriginal<typeof import('@dxheroes/mcp-kit')>();
  return { ...original, safeFetch: mockSafeFetch };
});

const { ByzdataMcpServer } = await import('../src/server.js');

/**
 * IČOs are handed out per test.
 *
 * `JusticeScraper` caches subjektId lookups in a module-level Map that no test
 * can reach, so reusing one IČO across tests would leak state between them.
 */
let icoCounter = 10000000;
function freshIco(): string {
  icoCounter -= 1;
  return String(icoCounter);
}

async function newServer() {
  const server = new ByzdataMcpServer();
  await server.initialize();
  return server;
}

function route(routes: Route[]): void {
  routeRequests(mockSafeFetch, routes);
}

const ARES_OK: Route[] = [
  [ARES_SEARCH_URL, () => jsonResponse({ pocetCelkem: 0, ekonomickeSubjekty: [] })],
  [ARES_VR_URL, () => jsonResponse({ zaznamy: [] })],
  [ARES_RZP_URL, () => jsonResponse({ zaznamy: [] })],
  [ARES_SUBJECT_URL, () => jsonResponse(aresSubject())],
];

beforeEach(() => {
  vi.clearAllMocks();
});

// ── MCP annotations (the operator's only lever) ───────────────────────

describe('tool annotations', () => {
  it('should annotate every tool, so none defaults into the write group', async () => {
    const tools = await (await newServer()).listTools();
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
    }
  });

  it('should mark all nine tools read-only', async () => {
    // Pinned, not floored. A floor of 8 against an actual 9 would let one tool
    // quietly lose its annotation, which is the failure this block exists to
    // catch. Everything here is a lookup into a public registry; the package
    // has no write surface at all.
    const tools = await (await newServer()).listTools();
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true);
    expect(tools.length).toBe(9);
    expect(readOnly.length).toBe(9);
    expect(readOnly.map((t) => t.name).sort()).toEqual(
      [
        'check_company_health',
        'check_insolvency',
        'find_related_companies',
        'get_company',
        'get_company_details',
        'get_company_documents',
        'get_company_extract',
        'get_company_relations',
        'search_company',
      ].sort(),
    );
  });

  it('should not mark any tool destructive', async () => {
    // ARES, the commercial register and eISIR expose no write surface to this
    // package, so there is nothing here that can be destructive. A future tool
    // that changes that has to change this test on its way in.
    const tools = await (await newServer()).listTools();
    for (const tool of tools) {
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
    expect(tools.filter((t) => t.annotations?.destructiveHint === true).length).toBe(0);
  });

  it('should mark the lookups idempotent and open-world', async () => {
    const tools = await (await newServer()).listTools();
    for (const tool of tools) {
      expect(tool.annotations?.idempotentHint, tool.name).toBe(true);
      expect(tool.annotations?.openWorldHint, tool.name).toBe(true);
    }
  });

  it('should expose resources without annotations', async () => {
    // `annotations` is a property of a tool in the MCP spec; resources have no
    // equivalent. Their absence here is the spec, not an oversight.
    const resources = await (await newServer()).listResources();
    expect(resources.length).toBe(3);
    for (const resource of resources) {
      expect(resource).not.toHaveProperty('annotations');
    }
  });
});

// ── Structured errors ──────────────────────────────────────────────────

describe('error responses', () => {
  it('should reject a malformed IČO as INVALID_INPUT, not as a tool error', async () => {
    // Everything used to arrive as TOOL_ERROR, so "your argument is wrong" and
    // "the registry is down" were the same answer with the same remedy: none.
    const result = await (await newServer()).callTool('get_company', { ico: 'CZ27074358' });
    expect(isError(result)).toBe(true);
    const body = parseError(result);
    expect(body.error).toBe('INVALID_INPUT');
    expect(body.hint).toContain('1-8 digits');
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('should report an unavailable registry with a code that says so', async () => {
    route([[/.*/, () => failureResponse(503, 'Service Unavailable')]]);
    const body = parseError(await (await newServer()).callTool('get_company', { ico: freshIco() }));
    expect(body.error).toBe('UPSTREAM_UNAVAILABLE');
    expect(body.hint).toContain('Do NOT report the company as missing');
  });

  it('should report throttling separately from an outage', async () => {
    route([[/.*/, () => failureResponse(429, 'Too Many Requests')]]);
    const body = parseError(await (await newServer()).callTool('get_company', { ico: freshIco() }));
    expect(body.error).toBe('RATE_LIMITED');
  });

  it('should keep the code out of the message', async () => {
    route([[/.*/, () => failureResponse(503, 'Service Unavailable')]]);
    const body = parseError(await (await newServer()).callTool('get_company', { ico: freshIco() }));
    expect(body.message).toBe('ARES returned HTTP 503 Service Unavailable');
    expect(body.message).not.toContain('UPSTREAM_UNAVAILABLE');
  });

  it('should report an unreachable registry rather than an empty answer', async () => {
    route([[/.*/, () => Promise.reject(new Error('ETIMEDOUT'))]]);
    const body = parseError(await (await newServer()).callTool('get_company', { ico: freshIco() }));
    expect(body.error).toBe('NETWORK_ERROR');
  });

  it('should still report an unknown tool distinctly', async () => {
    const body = parseError(await (await newServer()).callTool('no_such_tool', {}));
    expect(body.error).toBe('UNKNOWN_TOOL');
  });
});

// ── "No such company" must not be reachable from a failure ────────────

describe('absent record vs. unavailable registry', () => {
  it('should say NOT_FOUND when ARES answers 404 for the IČO', async () => {
    route([
      [ARES_VR_URL, () => failureResponse(404)],
      [ARES_SUBJECT_URL, () => failureResponse(404)],
    ]);
    const body = parseError(await (await newServer()).callTool('get_company', { ico: freshIco() }));
    expect(body.error).toBe('NOT_FOUND');
  });

  it('should not say NOT_FOUND when ARES is merely down', async () => {
    // The distinction the whole change is about: a model that cannot tell
    // these apart will tell a user a company does not exist because the
    // register was unreachable.
    const ico = freshIco();
    route([[/.*/, () => failureResponse(404)]]);
    const missing = parseError(await (await newServer()).callTool('get_company', { ico }));

    route([[/.*/, () => failureResponse(503)]]);
    const broken = parseError(
      await (await newServer()).callTool('get_company', { ico: freshIco() }),
    );

    expect(missing.error).toBe('NOT_FOUND');
    expect(broken.error).toBe('UPSTREAM_UNAVAILABLE');
    expect(missing.error).not.toBe(broken.error);
  });

  it('should not turn a 404 on the search endpoint into "no companies found"', async () => {
    // `searchSubjects` used to fall back to an empty result set on 404, so a
    // broken search endpoint rendered as a confident "no such company".
    route([[ARES_SEARCH_URL, () => failureResponse(404)]]);
    const result = await (await newServer()).callTool('search_company', { query: 'Alza' });
    expect(isError(result)).toBe(true);
    expect(parseError(result).error).toBe('NOT_FOUND');
    expect(textOf(result)).not.toContain('No companies found');
  });

  it('should still report a genuinely empty search as empty', async () => {
    route([[ARES_SEARCH_URL, () => jsonResponse({ pocetCelkem: 0, ekonomickeSubjekty: [] })]]);
    const result = await (await newServer()).callTool('search_company', { query: 'Alza' });
    expect(isError(result)).toBe(false);
    expect(textOf(result)).toContain('No companies found');
  });
});

// ── The scraper path must fail like the JSON paths ────────────────────

describe('justice.cz scraper errors', () => {
  it('should produce the same response shape as an ARES failure', async () => {
    // The scraper threw a bare Error; ARES threw an HttpError. Unifying one
    // and not the other would have looked finished and not been.
    route([[JUSTICE_URL, () => failureResponse(503, 'Service Unavailable')]]);
    const scraped = parseError(
      await (await newServer()).callTool('get_company_extract', { ico: freshIco() }),
    );

    route([[/.*/, () => failureResponse(503, 'Service Unavailable')]]);
    const ares = parseError(await (await newServer()).callTool('get_company', { ico: freshIco() }));

    expect(scraped.error).toBe(ares.error);
    expect(scraped.hint).toBe(ares.hint);
    expect(scraped.message).toBe('justice.cz returned HTTP 503 Service Unavailable');
  });

  it('should code a document-list failure too', async () => {
    route([[JUSTICE_URL, () => failureResponse(429)]]);
    const body = parseError(
      await (await newServer()).callTool('get_company_documents', { ico: freshIco() }),
    );
    expect(body.error).toBe('RATE_LIMITED');
  });

  it('should still report a company absent from the register as NOT_FOUND', async () => {
    // A 200 with no subjektId in the page is the register saying "no such
    // company", and stays distinct from the register failing.
    route([[JUSTICE_URL, () => htmlResponse('<html><body>nic</body></html>')]]);
    const body = parseError(
      await (await newServer()).callTool('get_company_extract', { ico: freshIco() }),
    );
    expect(body.error).toBe('NOT_FOUND');
  });
});

// ── Insolvency: silence is not a clean bill of health ─────────────────

describe('insolvency lookups', () => {
  it('should not report "no insolvency" when eISIR did not answer', async () => {
    // The most dangerous behaviour in the package: `checkInsolvency` swallowed
    // every failure into `[]`, which renders as "Insolvence: NE". An
    // unreachable insolvency register produced a clean result for a company
    // that may well be insolvent.
    route([[ISIR_URL, () => failureResponse(503)]]);
    const result = await (await newServer()).callTool('check_insolvency', { ico: freshIco() });
    expect(isError(result)).toBe(true);
    expect(parseError(result).error).toBe('UPSTREAM_UNAVAILABLE');
    expect(textOf(result)).not.toContain('Insolvence: NE');
  });

  it('should report a genuinely empty register answer as no insolvency', async () => {
    route([[ISIR_URL, () => jsonResponse({ list: [], count: 0, totalCount: 0 })]]);
    const result = await (await newServer()).callTool('check_insolvency', { ico: freshIco() });
    expect(isError(result)).toBe(false);
    expect(textOf(result)).toContain('Insolvence: NE');
  });
});

describe('check_company_health', () => {
  it('should degrade the insolvency check instead of failing the whole report', async () => {
    route([...ARES_OK, [ISIR_URL, () => failureResponse(503)]]);
    const result = await (await newServer()).callTool('check_company_health', {
      ico: freshIco(),
    });

    expect(isError(result)).toBe(false);
    const text = textOf(result);
    // The other four checks still ran…
    expect(text).toContain('Obchodní rejstřík');
    expect(text).toContain('Živnosti');
    // …and the one that did not is named as unresolved, not as clean.
    expect(text).toContain('NEZJIŠTĚNO');
    expect(text).not.toContain('Bez insolvence');
  });

  it('should refuse to hand out a green verdict on an incomplete check', async () => {
    // A green overall status on a health check that could not read the
    // insolvency register is worse than no status: the reader cannot tell.
    route([...ARES_OK, [ISIR_URL, () => failureResponse(503)]]);
    const text = textOf(
      await (await newServer()).callTool('check_company_health', { ico: freshIco() }),
    );
    expect(text).toContain('NEÚPLNÉ');
    expect(text).not.toContain('🟢 OK');
    expect(text).toContain('Nehodnoť firmu jako bezproblémovou');
  });

  it('should give a normal verdict when every check ran', async () => {
    route([...ARES_OK, [ISIR_URL, () => jsonResponse({ list: [], count: 0, totalCount: 0 })]]);
    const text = textOf(
      await (await newServer()).callTool('check_company_health', { ico: freshIco() }),
    );
    expect(text).toContain('Bez insolvence');
    expect(text).not.toContain('NEÚPLNÉ');
    expect(text).not.toContain('NEZJIŠTĚNO');
  });
});

describe('find_related_companies', () => {
  const RELATIONS_OK: Route[] = [
    [ARES_VR_URL, () => jsonResponse(aresVrWithDirector())],
    [ARES_SUBJECT_URL, () => jsonResponse(aresSubject())],
  ];

  it('should not report "no connected companies" when every person search failed', async () => {
    // Same class of bug as the swallowed insolvency lookup: a per-person
    // `catch {}` turned a justice.cz outage into a confident negative finding.
    route([...RELATIONS_OK, [JUSTICE_URL, () => failureResponse(503)]]);
    const text = textOf(
      await (await newServer()).callTool('find_related_companies', { ico: freshIco() }),
    );
    expect(text).not.toContain('Žádné další firmy propojené');
    expect(text).toContain('NENÍ zjištění');
  });

  it('should report a genuinely empty search as no connected companies', async () => {
    route([...RELATIONS_OK, [JUSTICE_URL, () => htmlResponse('<html><body></body></html>')]]);
    const text = textOf(
      await (await newServer()).callTool('find_related_companies', { ico: freshIco() }),
    );
    expect(text).toContain('Žádné další firmy propojené');
  });
});
