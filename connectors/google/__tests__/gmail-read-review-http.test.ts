import { createConnectorHttpServer } from '@dxheroes/mcp-runtime';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { endpoints, mcpPackage } from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
for (const era of ['auto', 'legacy'] as const) {
  it(`${era}: fails closed on empty read 2xx and continues large mailbox content through real MCP HTTP`, async () => {
    const realFetch = globalThis.fetch;
    let mode: 'empty200' | 'empty204' | 'empty-valid' | 'large' | 'large-body' = 'empty200';
    let bodyDownloads = 0;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return realFetch(input, init);
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer reader-token');
      if (url.pathname.endsWith('/profile'))
        return Response.json({ emailAddress: 'reader@example.test' });
      if (mode === 'empty200') return new Response('', { status: 200 });
      if (mode === 'empty204') return new Response(null, { status: 204 });
      if (mode === 'empty-valid') return Response.json({ resultSizeEstimate: 0 });
      if (url.pathname.endsWith('/threads/t1')) {
        expect(url.searchParams.get('format')).toBe('minimal');
        return Response.json({ id: 't1', messages: [{ id: 'm1', threadId: 't1' }] });
      }
      expect(url.pathname).toBe('/gmail/v1/users/me/messages/m1');
      const dataSelected = !url.searchParams.get('fields')?.includes('body(size,attachmentId)');
      if (dataSelected) bodyDownloads++;
      if (mode === 'large-body')
        return Response.json({
          id: 'm1',
          threadId: 't1',
          payload: {
            partId: '',
            mimeType: 'text/plain',
            body: {
              size: 3 * 1024 * 1024,
              ...(dataSelected
                ? { data: Buffer.alloc(3 * 1024 * 1024, 'x').toString('base64url') }
                : {}),
            },
          },
        });
      return Response.json({
        id: 'm1',
        threadId: 't1',
        payload: {
          partId: '',
          mimeType: 'multipart/mixed',
          headers: [{ name: 'Subject', value: 'Large fixture' }],
          parts: [
            {
              partId: '0',
              mimeType: 'text/plain',
              body: {
                size: 5,
                ...(dataSelected ? { data: Buffer.from('hello').toString('base64url') } : {}),
              },
            },
            {
              partId: '1',
              mimeType: 'text/plain',
              filename: '',
              headers: [{ name: 'Content-Disposition', value: 'attachment' }],
              body: {
                size: 3 * 1024 * 1024,
                ...(dataSelected
                  ? { data: Buffer.alloc(3 * 1024 * 1024, 'x').toString('base64url') }
                  : {}),
              },
            },
          ],
        },
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
        maxBodyBytes: 4096,
        totalTimeoutMs: 3000,
        idleTimeoutMs: 1000,
      },
      endpoints,
    );
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    const client = new Client(
      { name: 'review-read-test', version: '1' },
      era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
    );
    try {
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
                'X-MCP-Upstream-Credential': Buffer.from('reader-token').toString('base64url'),
              },
            },
          },
        ),
      );
      for (const invalidMode of ['empty200', 'empty204'] as const) {
        mode = invalidMode;
        const result = await client.callTool({
          name: 'gmail_find_sent_message',
          arguments: { messageId: '<job@example.test>' },
        });
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: { code: 'INVALID_PROVIDER_RESPONSE' } },
        });
        expect(result.structuredContent).not.toHaveProperty('complete', true);
      }
      mode = 'empty-valid';
      expect(
        await client.callTool({
          name: 'gmail_find_sent_message',
          arguments: { messageId: '<job@example.test>' },
        }),
      ).toMatchObject({ structuredContent: { messages: [], complete: true } });
      mode = 'large';
      const thread = await client.callTool({ name: 'gmail_get_thread', arguments: { id: 't1' } });
      expect(thread).toMatchObject({
        structuredContent: {
          complete: false,
          nextCursor: null,
          messages: [{ bodyReference: { tool: 'gmail_get_message', arguments: { id: 'm1' } } }],
        },
      });
      const message = await client.callTool({ name: 'gmail_get_message', arguments: { id: 'm1' } });
      expect(message).toMatchObject({
        structuredContent: {
          complete: false,
          message: {
            headers: [{ name: 'Subject', value: 'Large fixture' }],
            parts: [
              { complete: false },
              { partId: '1', bodyReference: { tool: 'gmail_get_attachment' } },
            ],
          },
        },
      });
      mode = 'large-body';
      expect(
        await client.callTool({ name: 'gmail_get_message', arguments: { id: 'm1' } }),
      ).toMatchObject({
        structuredContent: {
          complete: false,
          nextCursor: null,
          message: {
            parts: [
              {
                complete: false,
                bodyReference: { tool: 'gmail_get_attachment' },
                providerReference: { path: 'users/me/messages/m1', supportsRange: false },
              },
            ],
          },
        },
      });
      expect(bodyDownloads).toBe(0);
    } finally {
      await client.close();
      await runtime.close();
    }
  });
}
