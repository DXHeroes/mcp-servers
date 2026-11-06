import { type McpPackage, McpServer } from '@dxheroes/mcp-kit';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createConnectorHttpServer } from '../src/http.js';
import { UpstreamCredentialInvalidError } from '../src/oauth-errors.js';

class RefusingServer extends McpServer {
  async initialize() {}
  async close() {}
  async listTools() {
    return [{ name: 'read', description: 'Read', inputSchema: z.object({}) }];
  }
  async listResources() {
    return [];
  }
  async readResource() {
    throw new UpstreamCredentialInvalidError();
  }
  async callTool() {
    throw new UpstreamCredentialInvalidError();
  }
}
const pkg: McpPackage = {
  metadata: { id: 'fixture', name: 'Fixture', description: '', version: '1', requiresApiKey: true },
  createServer: () => new RefusingServer(),
};
for (const era of ['auto', 'legacy'] as const) {
  it(`${era}: returns a dedicated MCP error for upstream auth, not an HTTP service 401`, async () => {
    const runtime = createConnectorHttpServer(
      pkg,
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
      [{ path: '/tasks/mcp', package: pkg, auth: 'oauth' }],
    );
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    const client = new Client(
      { name: 'test', version: '1' },
      era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
    );
    try {
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
                'X-MCP-Upstream-Credential': Buffer.from('user-only').toString('base64url'),
              },
            },
          },
        ),
      );
      for (const run of [
        () => client.callTool({ name: 'read' }),
        () => client.readResource({ uri: 'test://value' }),
      ]) {
        await expect(run()).rejects.toMatchObject({
          code: -32050,
          data: {
            'io.dxheroes.connector/error': { version: 1, reason: 'upstream_credential_invalid' },
          },
        });
      }
    } finally {
      await client.close();
      await runtime.close();
    }
  });
}
