/**
 * Shared harness for the ByzData suite.
 *
 * The package has three upstreams and no injectable client, so the seam the
 * tests take is `safeFetch` itself: mock it once and the real clients, the
 * real service layer and the real server all run against it. That is what
 * makes it possible to assert that a 503 from the HTML scraper produces the
 * same response shape as a 503 from the ARES JSON API — the thing that was
 * not true before, and that a mock placed higher up would not have caught.
 *
 * The `vi.mock('@dxheroes/mcp-kit', …)` call itself stays in each test
 * file: it has to be hoisted above the imports, which only works at the top
 * level of the file doing the mocking.
 */

import type { Mock } from 'vitest';

export interface ResponseInitLike {
  status?: number;
  statusText?: string;
}

/** Minimal `Response` stand-in — the code only ever reads these four members. */
export function jsonResponse(body: unknown, init: ResponseInitLike = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

export function htmlResponse(html: string, init: ResponseInitLike = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? '',
    json: async () => {
      throw new Error('not json');
    },
    text: async () => html,
  } as unknown as Response;
}

/** A non-2xx answer that still has a body, the way the registries send them. */
export function failureResponse(status: number, statusText = ''): Response {
  return jsonResponse({ message: 'upstream said no' }, { status, statusText });
}

export type Route = [matcher: RegExp, respond: (url: string) => Response | Promise<Response>];

/**
 * Route mocked requests by URL.
 *
 * A single tool call fans out over up to six upstream requests (the health
 * check hits ARES three times and eISIR once), so matching on the URL is the
 * only way to say "ARES is fine but eISIR is down" — which is exactly the
 * situation the interesting assertions are about.
 */
export function routeRequests(mock: Mock, routes: Route[]): void {
  mock.mockImplementation(async (url: string) => {
    for (const [matcher, respond] of routes) {
      if (matcher.test(url)) return respond(url);
    }
    throw new Error(`Unrouted request in test: ${url}`);
  });
}

/** Parse the JSON error payload out of a tool response. */
export function parseError(result: unknown): { error: string; message: string; hint?: string } {
  const typed = result as { content?: Array<{ text?: string }> };
  return JSON.parse(String(typed.content?.[0]?.text));
}

/** Read the plain text out of a tool response. */
export function textOf(result: unknown): string {
  const typed = result as { content?: Array<{ text?: string }> };
  return String(typed.content?.[0]?.text);
}

export function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

export const ARES_SEARCH_URL = /ekonomicke-subjekty\/vyhledat$/;
export const ARES_SUBJECT_URL = /ekonomicke-subjekty\/\d+$/;
export const ARES_VR_URL = /ekonomicke-subjekty-vr\//;
export const ARES_RZP_URL = /ekonomicke-subjekty-rzp\//;
export const ISIR_URL = /eisir\.justice\.cz/;
export const JUSTICE_URL = /or\.justice\.cz/;

/** A subject the service layer can render without any optional field present. */
export function aresSubject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ico: '27074358',
    obchodniJmeno: 'Testovací s.r.o.',
    pravniForma: '112',
    datumVzniku: '2005-03-01',
    sidlo: { nazevObce: 'Praha', psc: 11000, textovaAdresa: 'Praha 1' },
    czNace: ['62010'],
    seznamRegistraci: {
      stavZdrojeVr: 'AKTIVNI',
      stavZdrojeRzp: 'AKTIVNI',
      stavZdrojeDph: 'AKTIVNI',
    },
    ...overrides,
  };
}

/** A VR record with one statutory body member, enough to drive `getRelations`. */
export function aresVrWithDirector(name = 'Jan Novák'): Record<string, unknown> {
  const [jmeno, prijmeni] = name.split(' ');
  return {
    zaznamy: [
      {
        statutarniOrgany: [
          {
            nazevOrganu: 'jednatel',
            clenoveOrganu: [
              {
                fyzickaOsoba: { jmeno, prijmeni },
                clenstvi: { funkce: { nazev: 'jednatel', vznikFunkce: '2010-01-01' } },
              },
            ],
          },
        ],
      },
    ],
  };
}
