/** Real HTTP requests exercise context parsing before connector construction in both MCP eras. */
import { request } from 'node:http';
import { type ApiKeyConfig, type McpPackage, McpServer } from '@dxheroes/mcp-kit';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { createConnectorHttpServer } from '../src/http.js';

const created: Array<ApiKeyConfig | null> = [];
class Fixture extends McpServer {
  async initialize() {}
  async listTools() {
    return [];
  }
  async callTool() {
    return { content: [] };
  }
  async close() {}
  async listResources() {
    return [];
  }
  async readResource() {
    return { contents: [] };
  }
}
const pkg: McpPackage = {
  metadata: {
    id: 'synthetic',
    name: 'Synthetic',
    description: 'Context fixture',
    version: '1',
    requiresApiKey: true,
    oauthDefaults: {
      authorizationServerUrl: 'https://oauth.example.test',
      authorizationEndpoint: 'https://oauth.example.test/authorize',
      tokenEndpoint: 'https://oauth.example.test/token',
      scopes: [],
      providerExtraFields: ['api_domain'],
    },
  },
  createServer(credential) {
    created.push(credential);
    return new Fixture();
  },
};
const config: RuntimeConfig = {
  host: '127.0.0.1',
  port: 0,
  allowedHosts: ['127.0.0.1'],
  allowedOrigins: [],
  accessToken: 'synthetic-service',
  sharedCredential: 'synthetic-shared',
  localTestMode: false,
  maxBodyBytes: 2048,
  totalTimeoutMs: 3000,
  idleTimeoutMs: 1000,
};
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  created.length = 0;
});
async function start(declared = true) {
  const target = declared
    ? pkg
    : {
        ...pkg,
        metadata: {
          ...pkg.metadata,
          oauthDefaults: { ...pkg.metadata.oauthDefaults!, providerExtraFields: [] },
        },
      };
  const runtime = createConnectorHttpServer(target, config, [
    { path: '/oauth/mcp', package: target, auth: 'oauth' },
    { path: '/mcp', package: target },
  ]);
  await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => runtime.close());
  return `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
}
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const headers = (index = 0) => ({
  Authorization: 'Bearer synthetic-service',
  'X-MCP-Credential-Mode': 'per_user',
  'X-MCP-Upstream-Credential': Buffer.from(`synthetic-access-${index}`).toString('base64url'),
});

describe('OAuth provider context', () => {
  it.each(['legacy', 'auto'] as const)(
    'keeps two caller contexts isolated on %s requests',
    async (era) => {
      const origin = await start();
      await Promise.all(
        [0, 1].map(async (index) => {
          const c = new Client(
            { name: 'synthetic', version: '1' },
            era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
          );
          try {
            await c.connect(
              new StreamableHTTPClientTransport(new URL(`${origin}/oauth/mcp`), {
                requestInit: {
                  headers: {
                    ...headers(index),
                    'X-MCP-Upstream-Context': encoded({
                      version: 1,
                      providerExtras: { api_domain: `https://tenant-${index}.pipedrive.com` },
                    }),
                  },
                },
              }),
            );
            await c.listTools();
          } finally {
            await c.close();
          }
        }),
      );
      expect(created.length).toBeGreaterThanOrEqual(2);
      for (const credential of created) {
        expect(credential!.providerExtras).toEqual({
          api_domain: `https://tenant-${credential!.apiKey.endsWith('0') ? '0' : '1'}.pipedrive.com`,
        });
        expect(JSON.stringify(credential)).not.toContain('synthetic-service');
        expect(JSON.stringify(credential)).not.toContain('synthetic-shared');
      }
    },
  );
  it.each([
    'not+base64',
    encoded({ version: 2, providerExtras: {} }),
    encoded({ version: 1, providerExtras: { refresh_token: 'synthetic-private' } }),
    encoded({ version: 1, providerExtras: { api_domain: 'http://tenant.pipedrive.com' } }),
    encoded({ version: 1, providerExtras: {}, extra: 'synthetic-private' }),
    Buffer.alloc(4097, 32).toString('base64url'),
    Buffer.from([0xff, 0xfe]).toString('base64url'),
  ])('refuses malformed context before constructing a connector %#', async (context) => {
    const origin = await start();
    const response = await fetch(`${origin}/oauth/mcp`, {
      method: 'POST',
      headers: {
        ...headers(),
        'X-MCP-Upstream-Context': context,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"error":"invalid_upstream_context"}');
    expect(created).toEqual([]);
  });
  it('refuses duplicate context headers and context on a legacy API-key route', async () => {
    const origin = await start();
    const context = encoded({
      version: 1,
      providerExtras: { api_domain: 'https://tenant.pipedrive.com' },
    });
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        `${origin}/oauth/mcp`,
        { method: 'POST', headers: { ...headers(), 'X-MCP-Upstream-Context': [context, context] } },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode!, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(response).toEqual({ status: 400, body: '{"error":"invalid_headers"}' });
    const keyed = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { ...headers(), 'X-MCP-Upstream-Context': context },
    });
    expect(keyed.status).toBe(400);
    expect(created).toEqual([]);
  });
  it('refuses fields not declared by the endpoint before constructing a connector', async () => {
    const origin = await start(false);
    const response = await fetch(`${origin}/oauth/mcp`, {
      method: 'POST',
      headers: {
        ...headers(),
        'X-MCP-Upstream-Context': encoded({
          version: 1,
          providerExtras: { api_domain: 'https://tenant.pipedrive.com' },
        }),
      },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"error":"invalid_upstream_context"}');
    expect(created).toEqual([]);
  });
  it('snapshots the allowlist when endpoints register, including later metadata replacement', async () => {
    const fields: Array<'api_domain'> = [];
    const target: McpPackage = {
      ...pkg,
      metadata: {
        ...pkg.metadata,
        oauthDefaults: { ...pkg.metadata.oauthDefaults!, providerExtraFields: fields },
      },
    };
    const runtime = createConnectorHttpServer(target, config, [
      { path: '/oauth/mcp', package: target, auth: 'oauth' },
    ]);
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => runtime.close());
    const origin = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
    fields.push('api_domain');
    target.metadata.oauthDefaults = {
      ...target.metadata.oauthDefaults!,
      providerExtraFields: ['api_domain'],
    };
    const response = await fetch(`${origin}/oauth/mcp`, {
      method: 'POST',
      headers: {
        ...headers(),
        'X-MCP-Upstream-Context': encoded({
          version: 1,
          providerExtras: { api_domain: 'https://tenant.pipedrive.com' },
        }),
      },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"error":"invalid_upstream_context"}');
    expect(created).toEqual([]);
  });
});
