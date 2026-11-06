import { createConnectorHttpServer } from '@dxheroes/mcp-runtime';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { endpoints, mcpPackage } from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
for (const era of ['auto', 'legacy'] as const)
  it(`${era}: isolates two user accounts over real MCP HTTP for history, post and reaction`, async () => {
    const nativeFetch = globalThis.fetch;
    const sent: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return nativeFetch(input, init);
      expect(url.origin).toBe('https://slack.com');
      const headers = new Headers(init?.headers);
      const owner = headers.get('authorization')!;
      expect(owner).not.toContain('service-only');
      expect(headers.has('x-mcp-upstream-credential')).toBe(false);
      expect(headers.has('x-mcp-upstream-context')).toBe(false);
      if (init?.method === 'POST') sent.push(`${url.pathname}:${owner}`);
      if (owner === 'Bearer xoxp-revoked')
        return Response.json({ ok: false, error: 'token_revoked' });
      return Response.json({
        ok: true,
        owner,
        messages: [{ type: 'message', user: 'U123', text: 'Fixture', ts: '1700000000.123456' }],
        response_metadata: { next_cursor: '' },
      });
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
      for (const token of ['xoxp-one', 'xoxp-two', 'xoxp-revoked']) {
        const client = new Client(
          { name: 'slack-test', version: '1' },
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
        expect((await client.listTools()).tools).toHaveLength(9);
        if (token === 'xoxp-revoked') {
          await expect(
            client.callTool({ name: 'slack_get_history', arguments: { channel: 'C123' } }),
          ).rejects.toMatchObject({
            code: -32050,
            data: {
              'io.dxheroes.connector/error': { version: 1, reason: 'upstream_credential_invalid' },
            },
          });
          continue;
        }
        for (const call of [
          { name: 'slack_list_conversations', arguments: {} },
          { name: 'slack_get_history', arguments: { channel: 'C123' } },
          { name: 'slack_post_message', arguments: { channel: 'C123', text: 'Fixture' } },
          {
            name: 'slack_add_reaction',
            arguments: { channel: 'C123', timestamp: '1700000000.123456', name: 'thumbsup' },
          },
        ])
          expect(await client.callTool(call)).toMatchObject({
            structuredContent: { ok: true, owner: `Bearer ${token}` },
          });
      }
      expect(sent).toEqual([
        '/api/chat.postMessage:Bearer xoxp-one',
        '/api/reactions.add:Bearer xoxp-one',
        '/api/chat.postMessage:Bearer xoxp-two',
        '/api/reactions.add:Bearer xoxp-two',
      ]);
    } finally {
      await Promise.all(clients.map((c) => c.close()));
      await runtime.close();
    }
  });
