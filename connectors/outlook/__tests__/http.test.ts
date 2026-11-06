import { createConnectorHttpServer } from '@dxheroes/mcp-runtime';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { endpoints, mcpPackage } from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
for (const era of ['auto', 'legacy'] as const) {
  it(`${era}: keeps both Outlook services and two accounts isolated over real MCP HTTP`, async () => {
    const nativeFetch = globalThis.fetch;
    const writes: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return nativeFetch(input, init);
      expect(url.origin).toBe('https://graph.microsoft.com');
      const headers = new Headers(init?.headers);
      const token = headers.get('authorization');
      expect(token).not.toContain('service-only');
      expect(headers.has('x-mcp-upstream-credential')).toBe(false);
      if (init?.method === 'POST') {
        writes.push(`${url.pathname}:${token}`);
        return url.pathname.endsWith('/sendMail')
          ? new Response(null, { status: 202 })
          : Response.json({ id: `${token}-event` }, { status: 201 });
      }
      return Response.json({ value: [{ id: `${token}-record` }] });
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
        maxBodyBytes: 8192,
        totalTimeoutMs: 3000,
        idleTimeoutMs: 1000,
      },
      endpoints,
    );
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    const clients: Client[] = [];
    try {
      for (const service of ['mail', 'calendar'])
        for (const token of ['work', 'personal']) {
          const client = new Client(
            { name: 'outlook-test', version: '1' },
            era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
          );
          clients.push(client);
          await client.connect(
            new StreamableHTTPClientTransport(
              new URL(
                `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}/${service}/mcp`,
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
          expect((await client.listTools()).tools).toHaveLength(service === 'mail' ? 14 : 8);
          const read = await client.callTool({
            name: service === 'mail' ? 'mail_search_messages' : 'calendar_list_calendars',
            arguments: {},
          });
          expect(read).toMatchObject({
            structuredContent: { value: [{ id: `Bearer ${token}-record` }] },
          });
          const write = await client.callTool(
            service === 'mail'
              ? {
                  name: 'mail_send_message',
                  arguments: {
                    message: {
                      subject: 'Fixture',
                      toRecipients: [{ emailAddress: { address: 'recipient@example.test' } }],
                    },
                  },
                }
              : {
                  name: 'calendar_create_event',
                  arguments: {
                    subject: 'Fixture',
                    start: { dateTime: '2026-11-06T09:00:00', timeZone: 'UTC' },
                    end: { dateTime: '2026-11-06T10:00:00', timeZone: 'UTC' },
                  },
                },
          );
          expect(write.isError).not.toBe(true);
        }
      expect(writes).toEqual([
        '/v1.0/me/sendMail:Bearer work',
        '/v1.0/me/sendMail:Bearer personal',
        '/v1.0/me/events:Bearer work',
        '/v1.0/me/events:Bearer personal',
      ]);
    } finally {
      await Promise.all(clients.map((c) => c.close()));
      await runtime.close();
    }
  });
}
