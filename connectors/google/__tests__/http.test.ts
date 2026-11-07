import { createConnectorHttpServer } from '@dxheroes/mcp-runtime';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { endpoints, mcpPackage } from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
for (const era of ['auto', 'legacy'] as const) {
  it(`${era}: serves isolated Google accounts through /tasks/mcp with real MCP HTTP`, async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return realFetch(input, init);
      expect(url.origin).toBe('https://tasks.googleapis.com');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).not.toContain('service-only');
      expect(headers.has('x-mcp-upstream-credential')).toBe(false);
      return new Response(
        JSON.stringify({
          id: headers.get('authorization') === 'Bearer work-account' ? 'work' : 'personal',
          title: 'Synthetic task',
        }),
      );
    });
    const runtime = createConnectorHttpServer(
      mcpPackage,
      {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: ['127.0.0.1'],
        allowedOrigins: [],
        accessToken: 'service-only',
        sharedCredential: undefined,
        localTestMode: false,
        maxBodyBytes: 2048,
        totalTimeoutMs: 3000,
        idleTimeoutMs: 1000,
      },
      endpoints,
    );
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    const clients: Client[] = [];
    try {
      for (const token of ['work-account', 'personal-account']) {
        const client = new Client(
          { name: 'test', version: '1' },
          era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
        );
        clients.push(client);
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(
              `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}/tasks/mcp`,
            ),
            {
              requestInit: {
                headers: {
                  Authorization: 'Bearer service-only',
                  'X-MCP-Credential-Mode': 'per_user',
                  'X-MCP-Upstream-Credential': Buffer.from(token).toString('base64url'),
                },
              },
            },
          ),
        );
        expect((await client.listTools()).tools).toHaveLength(13);
      }
      const results = await Promise.all(
        clients.map((client) =>
          client.callTool({
            name: 'tasks_create_task',
            arguments: { tasklist: 'list', title: 'Synthetic task' },
          }),
        ),
      );
      expect(results).toMatchObject([
        { structuredContent: { id: 'work' } },
        { structuredContent: { id: 'personal' } },
      ]);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await runtime.close();
    }
  });
}
