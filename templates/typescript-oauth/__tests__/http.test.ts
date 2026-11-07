import { randomUUID } from 'node:crypto';
import { createConnectorHttpServer } from '@dxheroes/mcp-runtime';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endpoints, mcpPackage } from '../dist/index.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '203.0.113.10', family: 4 }],
}));

describe.each(['auto', 'legacy'] as const)('%s compiled OAuth template', (era) => {
  let runtime: ReturnType<typeof createConnectorHttpServer>;
  let url: URL;
  let token: string;
  let providerStatus: number;
  const clients: Client[] = [];

  beforeEach(async () => {
    token = `fixture-personal-${randomUUID()}`;
    providerStatus = 200;
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.hostname === '127.0.0.1') return realFetch(input, init);
      expect(target.origin).toBe('https://graph.microsoft.com');
      expect(target.pathname).toBe('/v1.0/me');
      expect(target.searchParams.get('$select')).toBe('id,displayName');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${token}`);
      expect(headers.has('x-mcp-upstream-credential')).toBe(false);
      if (providerStatus !== 200)
        return new Response('private provider diagnostic; fixture-service', {
          status: providerStatus,
          headers: { 'Retry-After': '120' },
        });
      return Response.json({ id: 'personal-fixture', displayName: 'Personal fixture' });
    });
    runtime = createConnectorHttpServer(
      mcpPackage,
      {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: ['127.0.0.1'],
        allowedOrigins: [],
        accessToken: 'fixture-service',
        sharedCredential: 'fixture-fallback-must-not-be-used',
        localTestMode: false,
        maxBodyBytes: 2048,
        totalTimeoutMs: 3000,
        idleTimeoutMs: 1000,
      },
      endpoints,
    );
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    url = new URL(
      `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}/profile/mcp`,
    );
  });

  afterEach(async () => {
    try {
      await Promise.allSettled(clients.splice(0).map((client) => client.close()));
      await runtime.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  async function connect(headers: Record<string, string> = {}) {
    const client = new Client(
      { name: 'oauth-template-test', version: '1' },
      era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
    );
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: {
            Authorization: 'Bearer fixture-service',
            'X-MCP-Credential-Mode': 'per_user',
            'X-MCP-Upstream-Credential': Buffer.from(token).toString('base64url'),
            ...headers,
          },
        },
      }),
    );
    return client;
  }

  it('lists its tool and uses only the delegated user token at Graph', async () => {
    const client = await connect();
    expect((await client.listTools()).tools).toMatchObject([
      { name: 'profile_get_me', annotations: { readOnlyHint: true, destructiveHint: false } },
    ]);
    expect(await client.callTool({ name: 'profile_get_me', arguments: {} })).toMatchObject({
      structuredContent: { id: 'personal-fixture', displayName: 'Personal fixture' },
    });
  });

  it('requires a user token even when the header is absent and a shared fallback exists', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer fixture-service',
        'X-MCP-Credential-Mode': 'per_user',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'upstream_credential_required' });
  });

  it.each([
    ['missing user token', { 'X-MCP-Upstream-Credential': '' }],
    ['shared mode', { 'X-MCP-Credential-Mode': 'shared' }],
    ['invalid service bearer', { Authorization: 'Bearer wrong-service' }],
  ])('refuses %s instead of using a fallback credential', async (_label, headers) => {
    await expect(connect(headers)).rejects.toThrow();
  });

  it('preserves the canonical reconnect signal after a provider 401', async () => {
    providerStatus = 401;
    const client = await connect();
    await expect(client.callTool({ name: 'profile_get_me', arguments: {} })).rejects.toMatchObject({
      code: -32050,
      data: {
        'io.dxheroes.connector/error': { version: 1, reason: 'upstream_credential_invalid' },
      },
    });
  });

  it.each([
    [403, 'PROVIDER_ERROR'],
    [429, 'RATE_LIMITED'],
  ])('keeps provider %i separate from reconnect and scrubs diagnostics', async (status, code) => {
    providerStatus = status;
    const client = await connect();
    const result = await client.callTool({ name: 'profile_get_me', arguments: {} });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code, status } } });
    expect(JSON.stringify(result)).not.toContain('private provider diagnostic');
    expect(JSON.stringify(result)).not.toContain('fixture-service');
    expect(JSON.stringify(result)).not.toContain(token);
  });
});
