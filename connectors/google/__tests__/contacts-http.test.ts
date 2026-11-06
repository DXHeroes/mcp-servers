import { createConnectorHttpServer } from '@dxheroes/mcp-runtime';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { endpoints, mcpPackage } from '../src/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());
for (const era of ['auto', 'legacy'] as const)
  it(`${era}: performs isolated contact read/create/update/read-back and separate directory access over real MCP HTTP`, async () => {
    const nativeFetch = globalThis.fetch;
    const contacts = new Map<string, { name: string; etag: string }>();
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return nativeFetch(input, init);
      expect(url.origin).toBe('https://people.googleapis.com');
      const headers = new Headers(init?.headers);
      const token = headers.get('authorization')!;
      expect([
        'Bearer personal-account',
        'Bearer work-account',
        'Bearer revoked-account',
      ]).toContain(token);
      expect(headers.has('x-mcp-upstream-credential')).toBe(false);
      expect(headers.has('x-mcp-upstream-context')).toBe(false);
      if (token === 'Bearer revoked-account') return new Response(null, { status: 401 });
      if (url.pathname === '/v1/people:searchDirectoryPeople')
        return token === 'Bearer personal-account'
          ? new Response('private-directory-denial', { status: 403 })
          : Response.json({
              people: [
                { resourceName: 'people/domain123', names: [{ displayName: 'Work fixture' }] },
              ],
            });
      if (url.pathname === '/v1/people:createContact') {
        const body = JSON.parse(String(init?.body));
        contacts.set(token, { name: body.names[0].givenName, etag: 'v1' });
      } else if (url.pathname === '/v1/people/c123:updateContact') {
        const body = JSON.parse(String(init?.body));
        const previous = contacts.get(token)!;
        if (body.metadata.sources[0].etag !== previous.etag)
          return new Response('private-conflict', { status: 400 });
        expect(url.searchParams.get('updatePersonFields')).toBe('names');
        contacts.set(token, { name: body.names[0].givenName, etag: 'v2' });
      } else expect(url.pathname).toBe('/v1/people/c123');
      const contact = contacts.get(token)!;
      return Response.json({
        resourceName: 'people/c123',
        names: [{ givenName: contact.name }],
        metadata: { sources: [{ type: 'CONTACT', id: '123', etag: contact.etag }] },
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
    async function connect(path: string, token: string) {
      const client = new Client(
        { name: 'contacts-test', version: '1' },
        era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
      );
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${(runtime.server.address() as { port: number }).port}${path}`),
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
      return client;
    }
    try {
      const contactClients = await Promise.all(
        ['personal-account', 'work-account'].map((token) => connect('/contacts/mcp', token)),
      );
      await Promise.all(
        contactClients.map(async (client, i) => {
          expect((await client.listTools()).tools).toHaveLength(7);
          expect(
            await client.callTool({
              name: 'contacts_create',
              arguments: { person: { names: [{ givenName: `Fixture ${i}` }] } },
            }),
          ).toMatchObject({
            structuredContent: {
              resourceName: 'people/c123',
              metadata: { sources: [{ type: 'CONTACT', id: '123', etag: 'v1' }] },
            },
          });
          expect(
            await client.callTool({
              name: 'contacts_get',
              arguments: { resourceName: 'people/c123' },
            }),
          ).toMatchObject({ structuredContent: { names: [{ givenName: `Fixture ${i}` }] } });
          expect(
            await client.callTool({
              name: 'contacts_update',
              arguments: {
                resourceName: 'people/c123',
                source: { id: '123', etag: 'v1' },
                person: { names: [{ givenName: `Updated ${i}` }] },
              },
            }),
          ).toMatchObject({ structuredContent: { metadata: { sources: [{ etag: 'v2' }] } } });
          expect(
            await client.callTool({
              name: 'contacts_get',
              arguments: { resourceName: 'people/c123' },
            }),
          ).toMatchObject({ structuredContent: { names: [{ givenName: `Updated ${i}` }] } });
          expect(
            await client.callTool({
              name: 'contacts_update',
              arguments: {
                resourceName: 'people/c123',
                source: { id: '123', etag: 'v1' },
                person: { names: [{ givenName: 'Stale' }] },
              },
            }),
          ).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'PROVIDER_ERROR', status: 400 } },
          });
        }),
      );
      const personalDirectory = await connect('/directory/mcp', 'personal-account');
      expect((await personalDirectory.listTools()).tools.map((t) => t.name)).toEqual([
        'directory_search',
      ]);
      expect(
        await personalDirectory.callTool({
          name: 'directory_search',
          arguments: { query: 'Work' },
        }),
      ).toMatchObject({ isError: true, structuredContent: { error: { status: 403 } } });
      const workDirectory = await connect('/directory/mcp', 'work-account');
      expect(
        await workDirectory.callTool({ name: 'directory_search', arguments: { query: 'Work' } }),
      ).toMatchObject({ structuredContent: { people: [{ resourceName: 'people/domain123' }] } });
      const revoked = await connect('/contacts/mcp', 'revoked-account');
      await expect(
        revoked.callTool({ name: 'contacts_get', arguments: { resourceName: 'people/c123' } }),
      ).rejects.toMatchObject({
        code: -32050,
        data: {
          'io.dxheroes.connector/error': { version: 1, reason: 'upstream_credential_invalid' },
        },
      });
    } finally {
      await Promise.all(clients.map((c) => c.close()));
      await runtime.close();
    }
  });
