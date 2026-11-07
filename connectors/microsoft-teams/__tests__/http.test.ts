import { createConnectorHttpServer } from '@dxheroes/mcp-runtime';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { endpoints, mcpPackage } from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
for (const era of ['auto', 'legacy'] as const) {
  it(`${era}: reads and posts for two delegated work accounts through real MCP HTTP`, async () => {
    const nativeFetch = globalThis.fetch;
    const posted: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return nativeFetch(input, init);
      expect(url.origin).toBe('https://graph.microsoft.com');
      const headers = new Headers(init?.headers);
      const owner = headers.get('authorization');
      expect(owner).not.toContain('service-only');
      expect(headers.has('x-mcp-upstream-credential')).toBe(false);
      if (init?.method === 'POST') posted.push(`${url.pathname}:${owner}`);
      return Response.json(init?.method === 'POST' ? { id: owner } : { value: [{ id: owner }] });
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
      for (const token of ['work-one', 'work-two']) {
        const client = new Client(
          { name: 'teams-test', version: '1' },
          era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
        );
        clients.push(client);
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${(runtime.server.address() as { port: number }).port}/mcp`),
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
        expect((await client.listTools()).tools).toHaveLength(10);
        for (const read of [
          { name: 'teams_list_chats', arguments: {} },
          { name: 'teams_list_channels', arguments: { teamId: 'team' } },
        ])
          expect(await client.callTool(read)).toMatchObject({
            structuredContent: { value: [{ id: `Bearer ${token}` }] },
          });
        for (const write of [
          {
            name: 'teams_send_chat_message',
            arguments: { chatId: 'chat', body: { contentType: 'text', content: 'Fixture' } },
          },
          {
            name: 'teams_post_channel_message',
            arguments: {
              teamId: 'team',
              channelId: 'channel',
              body: { contentType: 'text', content: 'Fixture' },
            },
          },
        ])
          expect(await client.callTool(write)).toMatchObject({
            structuredContent: { id: `Bearer ${token}` },
          });
      }
      expect(posted).toEqual([
        '/v1.0/chats/chat/messages:Bearer work-one',
        '/v1.0/teams/team/channels/channel/messages:Bearer work-one',
        '/v1.0/chats/chat/messages:Bearer work-two',
        '/v1.0/teams/team/channels/channel/messages:Bearer work-two',
      ]);
    } finally {
      await Promise.all(clients.map((c) => c.close()));
      await runtime.close();
    }
  });
}
