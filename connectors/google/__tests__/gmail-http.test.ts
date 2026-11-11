import { createConnectorHttpServer } from '@dxheroes/mcp-runtime';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { endpoints, mcpPackage } from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
for (const era of ['auto', 'legacy'] as const) {
  it(`${era}: serves isolated send-only Gmail accounts through /gmail/mcp with real MCP HTTP`, async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return realFetch(input, init);
      expect(url.origin).toBe('https://gmail.googleapis.com');
      expect(url.pathname).toBe('/gmail/v1/users/me/messages/send');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(Buffer.from(body.raw, 'base64url').toString('utf8')).toContain('Subject: ');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).not.toContain('service-only');
      expect(headers.has('x-mcp-upstream-credential')).toBe(false);
      return new Response(
        JSON.stringify({
          id: headers.get('authorization') === 'Bearer work-account' ? 'work' : 'personal',
          threadId: 'synthetic-thread',
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
              `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}/gmail/mcp`,
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
        expect((await client.listTools()).tools).toHaveLength(2);
      }
      const results = await Promise.all(
        clients.map((client) =>
          client.callTool({
            name: 'gmail_send_message',
            arguments: {
              from: 'sender@example.test',
              to: ['recipient@example.test'],
              subject: 'Synthetic message',
              text: 'Synthetic body',
            },
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

for (const era of ['auto', 'legacy'] as const) {
  it(`${era}: isolates readonly mailbox identity and forbids send through real MCP HTTP`, async () => {
    const realFetch = globalThis.fetch;
    const providerCalls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return realFetch(input, init);
      providerCalls.push(url.pathname);
      expect(init?.method).toBe('GET');
      const token = new Headers(init?.headers).get('authorization');
      expect(['Bearer work-account', 'Bearer personal-account']).toContain(token);
      return Response.json(
        url.pathname.endsWith('/profile')
          ? {
              emailAddress:
                token === 'Bearer work-account' ? 'work@example.test' : 'personal@example.test',
            }
          : { messages: [] },
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
          { name: 'read-test', version: '1' },
          era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
        );
        clients.push(client);
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(
              `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}/gmail-read/mcp`,
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
        const tools = (await client.listTools()).tools;
        expect(tools).toHaveLength(5);
        expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
        const sent = await client.callTool({ name: 'gmail_send_message', arguments: {} });
        expect(sent).toHaveProperty('isError', true);
      }
      expect(providerCalls).toEqual([]);
      const results = await Promise.all(
        clients.map((client) => client.callTool({ name: 'gmail_list_messages', arguments: {} })),
      );
      expect(results).toMatchObject([
        {
          structuredContent: {
            mailbox: { emailAddress: 'work@example.test', verified: true },
            messages: [],
            complete: true,
          },
        },
        {
          structuredContent: {
            mailbox: { emailAddress: 'personal@example.test', verified: true },
            messages: [],
            complete: true,
          },
        },
      ]);
      expect(providerCalls).toHaveLength(4);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await runtime.close();
    }
  });
}
