import type { McpPackage } from '@dxheroes/mcp-kit';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createConnectorHttpServer } from '../src/http.js';

// DNS and provider HTTP are deterministic. The MCP listener and official SDK client use real TCP.
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
const scenarios = [
  {
    id: 'abra-flexi',
    credential: 'https://203.0.113.10/c/fixture|fixture:synthetic',
    tool: 'flexi_list_contacts',
    args: {},
  },
  { id: 'byzdata', credential: undefined, tool: 'get_company', args: { ico: '12345678' } },
  {
    id: 'fakturoid',
    credential: 'fixture:client:synthetic',
    tool: 'fakturoid_list_subjects',
    args: {},
  },
  {
    id: 'gemini-deep-research',
    credential: 'synthetic-fixture',
    tool: 'deep_research',
    args: { topic: 'Synthetic research' },
  },
  { id: 'merk', credential: 'synthetic-fixture', tool: 'merk_subscription_info', args: {} },
  { id: 'toggl', credential: 'synthetic-fixture', tool: 'toggl_me', args: {} },
];
for (const scenario of scenarios)
  it(`${scenario.id} returns real connector successes through both SDK eras with transport auth kept out of upstream`, async () => {
    const realFetch = globalThis.fetch;
    let upstreamCalls = 0;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === '127.0.0.1') return realFetch(input, init);
      upstreamCalls++;
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      headers.forEach((value) => {
        expect(value).not.toContain('transport-secret-only');
      });
      expect(headers.has('x-mcp-upstream-credential')).toBe(false);
      expect(headers.has('x-mcp-credential-mode')).toBe(false);
      let body: unknown;
      if (url.hostname === '203.0.113.10')
        body = { winstrom: { adresar: [{ id: 42, nazev: 'Synthetic record' }] } };
      else if (url.hostname === 'ares.gov.cz')
        body = url.pathname.includes('ekonomicke-subjekty-vr')
          ? { zaznamy: [] }
          : {
              ico: '12345678',
              obchodniJmeno: 'Synthetic record',
              sidlo: { textovaAdresa: 'Synthetic street' },
              pravniForma: '112',
            };
      else if (url.hostname === 'app.fakturoid.cz')
        body = url.pathname.includes('token')
          ? { access_token: 'synthetic-provider-token', expires_in: 3600 }
          : [{ id: 42, name: 'Synthetic record' }];
      else if (url.hostname === 'generativelanguage.googleapis.com')
        body = {
          id: 'synthetic-interaction',
          status: 'completed',
          outputs: [{ type: 'text', text: 'Synthetic record' }],
        };
      else if (url.hostname === 'api.merk.cz') body = { name: 'Synthetic record' };
      else if (url.hostname === 'api.track.toggl.com')
        body = { id: 42, fullname: 'Synthetic record' };
      else throw new Error('Unexpected synthetic upstream endpoint');
      return Response.json(body);
    });
    const { mcpPackage: pkg } = (await import(
      new URL(`../../../connectors/${scenario.id}/dist/index.js`, import.meta.url).href
    )) as { mcpPackage: McpPackage };
    const runtime = createConnectorHttpServer(pkg, {
      host: '127.0.0.1',
      port: 0,
      allowedHosts: ['127.0.0.1'],
      allowedOrigins: [],
      accessToken: 'transport-secret-only',
      sharedCredential: scenario.credential,
      localTestMode: false,
      maxBodyBytes: 2097152,
      totalTimeoutMs: 3000,
      idleTimeoutMs: 1000,
    });
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    try {
      for (const era of ['legacy', 'auto'] as const) {
        const client = new Client(
          { name: 'upstream-test', version: '1.0.0' },
          era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
        );
        try {
          await client.connect(
            new StreamableHTTPClientTransport(
              new URL(
                `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}/mcp`,
              ),
              { requestInit: { headers: { Authorization: 'Bearer transport-secret-only' } } },
            ),
          );
          await client.listTools();
          const before = upstreamCalls;
          const result = await client.callTool({ name: scenario.tool, arguments: scenario.args });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          expect(JSON.stringify(result.content)).toContain('Synthetic record');
          expect(upstreamCalls).toBeGreaterThan(before);
          if (scenario.id === 'byzdata')
            expect(
              JSON.stringify(
                (await client.readResource({ uri: 'company://12345678/overview' })).contents,
              ),
            ).toContain('Synthetic record');
        } finally {
          await client.close();
        }
      }
    } finally {
      await runtime.close();
    }
  });
