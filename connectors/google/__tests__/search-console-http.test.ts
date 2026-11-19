import { createConnectorHttpServer } from '@dxheroes/mcp-runtime';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { endpoints, mcpPackage } from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());

const sites = ['sc-domain:personal.example', 'https://work.example/blog/'] as const;
const inspectionUrls = ['https://personal.example/page', `${sites[1]}page`] as const;
const dates = { startDate: '2026-10-01', endDate: '2026-10-31' };
const tools = {
  list: 'search_console_list_properties',
  get: 'search_console_get_property',
  query: 'search_console_query_analytics',
  inspect: 'search_console_inspect_url',
};

for (const era of ['auto', 'legacy'] as const) {
  it(`${era}: isolates concurrent accounts, bounds reports and reconnects the same property`, async () => {
    const nativeFetch = globalThis.fetch;
    let providerCalls = 0;
    let revoked = false;
    const tokens = ['personal', 'workspace', 'renewed-personal'];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return nativeFetch(input, init);
      providerCalls++;
      expect(url.origin).toBe('https://searchconsole.googleapis.com');
      const headers = new Headers(init?.headers);
      expect(headers.has('x-mcp-upstream-credential')).toBe(false);
      const token = headers.get('authorization')?.replace(/^Bearer /, '');
      expect(tokens).toContain(token);
      if (token === 'personal' && revoked) return new Response(null, { status: 401 });
      const account = token === 'workspace' ? 1 : 0;
      const siteUrl = sites[account];
      const property = { siteUrl, permissionLevel: 'siteFullUser' };
      const propertyPath = `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`;
      if (init?.method === 'GET' && url.pathname === '/webmasters/v3/sites')
        return Response.json({ siteEntry: [property] });
      if (init?.method === 'GET' && url.pathname === propertyPath) return Response.json(property);
      if (init?.method === 'POST' && url.pathname === `${propertyPath}/searchAnalytics/query`) {
        const args = JSON.parse(String(init.body));
        expect(args).toEqual({ ...dates, dimensions: ['date'], rowLimit: 10 });
        return Response.json({ rows: [{ keys: [dates.startDate], clicks: account + 1 }] });
      }
      if (init?.method === 'POST' && url.pathname === '/v1/urlInspection/index:inspect') {
        const args = JSON.parse(String(init.body));
        if (args.siteUrl !== siteUrl) return new Response(null, { status: 403 });
        if (args.inspectionUrl.endsWith('/throttled'))
          return new Response(null, {
            status: 429,
            headers: { 'retry-after': '120' },
          });
        expect(args).toEqual({
          siteUrl,
          inspectionUrl: inspectionUrls[account],
        });
        return Response.json({
          inspectionResult: {
            indexStatusResult: { verdict: 'PASS', googleCanonical: args.inspectionUrl },
          },
        });
      }
      return new Response('private-provider-details', { status: 403 });
    });

    const runtime = createConnectorHttpServer(
      mcpPackage,
      {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: ['127.0.0.1'],
        allowedOrigins: [],
        accessToken: 'connector-service',
        localTestMode: false,
        maxBodyBytes: 4096,
        totalTimeoutMs: 3000,
        idleTimeoutMs: 1000,
      },
      endpoints,
    );
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    const clients: Client[] = [];
    async function connect(token: string) {
      const client = new Client(
        { name: 'search-console-test', version: '1' },
        era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
      );
      clients.push(client);
      const { port } = runtime.server.address() as { port: number };
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/search-console/mcp`), {
          requestInit: {
            headers: {
              Authorization: 'Bearer connector-service',
              'X-MCP-Credential-Mode': 'per_user',
              'X-MCP-Upstream-Credential': Buffer.from(token).toString('base64url'),
            },
          },
        }),
      );
      return client;
    }
    try {
      async function check(client: Client, account: 0 | 1) {
        const siteUrl = sites[account];
        const own = { siteUrl };
        const otherAccount = account === 0 ? 1 : 0;
        const foreign = { siteUrl: sites[otherAccount] };
        const inspectionUrl = inspectionUrls[account];
        const advertised = (await client.listTools()).tools;
        expect(advertised.map((tool) => tool.name).sort()).toEqual(Object.values(tools).sort());
        expect(advertised.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
        const call = (name: string, args: Record<string, unknown>) =>
          client.callTool({ name, arguments: args });
        expect(await call(tools.list, {})).toMatchObject({
          structuredContent: { siteEntry: [own] },
        });
        expect(await call(tools.get, own)).toMatchObject({
          structuredContent: { ...own, permissionLevel: 'siteFullUser' },
        });
        expect(await call(tools.query, { ...own, ...dates, dimensions: ['date'] })).toMatchObject({
          structuredContent: { rows: [{ clicks: account + 1 }] },
        });
        expect(await call(tools.inspect, { ...own, inspectionUrl })).toMatchObject({
          structuredContent: {
            inspectionResult: {
              indexStatusResult: { verdict: 'PASS', googleCanonical: inspectionUrl },
            },
          },
        });
        for (const [name, args] of [
          [tools.get, foreign],
          [tools.query, { ...foreign, ...dates }],
          [tools.inspect, { ...foreign, inspectionUrl: inspectionUrls[otherAccount] }],
        ] as const) {
          const denied = await call(name, args);
          expect(denied).toMatchObject({
            isError: true,
            structuredContent: { error: { status: 403 } },
          });
          expect(JSON.stringify(denied)).not.toContain('private-provider-details');
        }
      }
      const [personal, work] = await Promise.all([connect('personal'), connect('workspace')]);
      await Promise.all([check(personal, 0), check(work, 1)]);
      const count = providerCalls;
      for (const invalid of [
        { rowLimit: 101 },
        { rowLimit: 0 },
        { endDate: '2026-11-01' },
        { endDate: '2026-09-30' },
        { startDate: '2026-09-31' },
        { dimensions: ['date', 'date'] },
        { startRow: 1 },
        { siteUrl: '..' },
      ]) {
        const result = await personal.callTool({
          name: tools.query,
          arguments: { siteUrl: sites[0], ...dates, ...invalid },
        });
        expect(result.isError).toBe(true);
      }
      expect(providerCalls).toBe(count);
      expect(
        await work.callTool({
          name: tools.inspect,
          arguments: { siteUrl: sites[1], inspectionUrl: `${sites[1]}throttled` },
        }),
      ).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'RATE_LIMITED', status: 429, retryAfterMs: 120000 } },
      });
      revoked = true;
      await expect(personal.callTool({ name: tools.list, arguments: {} })).rejects.toMatchObject({
        code: -32050,
        data: { 'io.dxheroes.connector/error': { reason: 'upstream_credential_invalid' } },
      });
      const renewed = await connect('renewed-personal');
      await check(renewed, 0);
      expect(await work.callTool({ name: tools.list, arguments: {} })).toMatchObject({
        structuredContent: { siteEntry: [{ siteUrl: sites[1] }] },
      });
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await runtime.close();
    }
  });
}
