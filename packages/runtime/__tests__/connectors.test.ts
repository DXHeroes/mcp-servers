import { fileURLToPath } from 'node:url';
import { type McpPackage, McpServer, normalizeToolInputSchemas } from '@dxheroes/mcp-kit';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, it } from 'vitest';
import { createConnectorHttpServer } from '../src/http.js';

const connectors = [
  ['abra-flexi', 30, 'https://203.0.113.10/c/fixture|fixture:synthetic'],
  ['byzdata', 9, undefined],
  ['fakturoid', 45, 'fixture:client:synthetic'],
  ['gemini-deep-research', 2, 'synthetic-fixture'],
  ['merk', 23, 'synthetic-fixture'],
  ['postgres', 2, 'postgresql://fixture:synthetic@127.0.0.1/fixture?sslmode=disable'],
  ['toggl', 34, 'synthetic-fixture'],
] as const;
for (const [id, count, credential] of connectors) {
  it(`${id} exposes the exact connector surface and handles actual HTTP calls in both eras`, async () => {
    const { mcpPackage: pkg } = (await import(
      new URL(`../../../connectors/${id}/dist/index.js`, import.meta.url).href
    )) as { mcpPackage: McpPackage };
    const runtime = createConnectorHttpServer(pkg, {
      host: '127.0.0.1',
      port: 0,
      allowedHosts: ['127.0.0.1'],
      allowedOrigins: [],
      accessToken: 'test-service-token',
      sharedCredential: credential,
      localTestMode: false,
      maxBodyBytes: 2097152,
      totalTimeoutMs: 300000,
      idleTimeoutMs: 300000,
    });
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    const direct: McpServer = pkg.createServer(
      credential
        ? { apiKey: credential, headerName: 'Authorization', headerValue: credential }
        : null,
    );
    await direct.initialize();
    try {
      for (const era of ['auto', 'legacy'] as const) {
        const client = new Client(
          { name: 'connector-test', version: '1.0.0' },
          era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
        );
        try {
          await client.connect(
            new StreamableHTTPClientTransport(
              new URL(
                `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}/mcp`,
              ),
              { requestInit: { headers: { Authorization: 'Bearer test-service-token' } } },
            ),
          );
          expect(client.getNegotiatedProtocolVersion()).toBe(
            era === 'auto' ? '2026-07-28' : '2025-11-25',
          );
          const tools = (await client.listTools()).tools;
          expect(tools).toHaveLength(count);
          expect(tools).toEqual(
            JSON.parse(JSON.stringify(normalizeToolInputSchemas(await direct.listTools()))),
          );
          expect((await client.listResources()).resources).toEqual(await direct.listResources());
          expect((await client.listPrompts()).prompts).toEqual(await direct.listPrompts());
          const result = await client.callTool({
            name: '__synthetic_unknown_tool__',
            arguments: {},
          });
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).not.toContain('test-service-token');
        } finally {
          await client.close();
        }
      }
    } finally {
      await direct.close();
      await runtime.close();
    }
  });
  it(`${id} starts its standalone stdio CLI and serves SDK requests without stdout diagnostics`, async () => {
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (pair): pair is [string, string] => pair[1] !== undefined,
        ),
      ),
      ...(credential ? { MCP_UPSTREAM_CREDENTIAL: credential } : {}),
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL(`../../../connectors/${id}/dist/cli.js`, import.meta.url)),
        '--stdio',
      ],
      env,
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(count);
      expect(
        (await client.callTool({ name: '__synthetic_unknown_tool__', arguments: {} })).isError,
      ).toBe(true);
    } finally {
      await client.close();
    }
  });
}

it('Gemini stdio research keeps provider progress diagnostics off the JSON-RPC stream', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'mcp-stdio-provider-'));
  const preload = join(dir, 'provider.mjs');
  await writeFile(
    preload,
    `globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname !== 'generativelanguage.googleapis.com') throw new Error('Unexpected fixture endpoint');
    return Response.json({ id: 'synthetic-interaction', status: 'completed', outputs: [{ type: 'text', text: 'Synthetic stdio research' }] });
  };`,
  );
  const client = new Client({ name: 'stdio-research-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      preload,
      fileURLToPath(
        new URL('../../../connectors/gemini-deep-research/dist/cli.js', import.meta.url),
      ),
      '--stdio',
    ],
    env: { MCP_UPSTREAM_CREDENTIAL: 'synthetic-research-credential' },
    stderr: 'pipe',
  });
  let diagnostics = '';
  try {
    await client.connect(transport);
    transport.stderr?.on('data', (chunk) => {
      diagnostics += chunk.toString();
    });
    const result = await client.callTool({
      name: 'deep_research',
      arguments: { topic: 'Synthetic topic' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Synthetic stdio research' }]);
    expect(diagnostics).toContain('Research started');
    expect(diagnostics).not.toContain('synthetic-research-credential');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
